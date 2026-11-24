"""Bounded fixtures for the existing reader, full context and lifecycle comparison."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
RUNTIME = Path(os.environ['CREW_FLOW_STAGES']).resolve().parent
sys.path.insert(0, str(RUNTIME))
sys.path.insert(1, str(RUNTIME.parent / 'planning'))
from context_reads import object_read
from flow_context import pages
from context_snapshot import snapshot_source


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


context = load('decider_context', HERE / 'context.py')
reader = load('decider_reader', HERE / 'reader.py')


class API:
    def __init__(self):
        self.calls = []

    def call(self, tool, args):
        self.calls.append((tool, args))
        if tool == 'joppa_objects' and not args.get('address'):
            offset = int(args.get('cursor', 0))
            rows = [{'address': 'ac:s' + str(i), 'parent': 'requirement:r', 'revision': 1} for i in range(offset, min(offset + 25, 34))]
            return {'items': rows, **({'next_cursor': '25'} if offset == 0 else {})}
        address = args['address']
        offset = int(args.get('comments_cursor', 0))
        comments = [{'id': str(i), 'text': 'Complete note ' + str(i) + ' ' + 'n' * 100} for i in range(offset, min(offset + 25, 32))]
        return {'address': address, 'revision': 1, 'present': True, 'parent': 'requirement:r' if address.startswith('ac:') else None,
                'data': {'title': address, 'body': 'Full body', 'owner': 'owner', 'all_fields': {'retained': True}, 'stage': 'to_decide'},
                'comments': {'items': comments, 'total': 32, **({'next_cursor': '25'} if offset == 0 else {})}}


class ContextTest(unittest.TestCase):
    def test_empty_evidence_gap_checks_both_roots_and_refuses_missing_or_unreadable_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); brain = root / 'brain'; manuals = root / 'manuals'; brain.mkdir(); manuals.mkdir()
            config = {'vars': {'BRAIN_ROOT': str(brain), 'MANUALS_ROOT': str(manuals)}}
            values = {'input.json': {}, 'draft.json': {'outcome': 'GAP', 'new_sources': [],
                      'research': {'searches': {'joppa': 'q', 'brain': 'q', 'manuals': 'q'}, 'sources': [], 'files': [], 'unavailable': []}},
                      'decider-assignment.json': {}}
            def require(ok, message):
                if not ok: raise ValueError(message)
            helpers = (lambda: root, None, lambda: config, None, None, None,
                       lambda file: copy.deepcopy(values[file.name]), None, require, None)
            with patch.object(context, 'native', return_value=helpers), patch.object(sys, 'argv', ['context.py', 'freeze']), patch.object(context, 'assignment') as save:
                context.main(); save.assert_called_once()
                manuals.rmdir(); save.reset_mock()
                with self.assertRaises(FileNotFoundError): context.main()
                save.assert_not_called(); manuals.mkdir()
                with patch.object(context.os, 'scandir', side_effect=OSError('EIO')):
                    with self.assertRaisesRegex(OSError, 'EIO'): context.main()
                save.assert_not_called()

    def test_wrong_evidence_quotes_and_revisions_return_to_the_author_instead_of_a_crash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); brain = root / 'brain'; manuals = root / 'manuals'; brain.mkdir(); manuals.mkdir()
            policy = brain / 'policy.md'; policy.write_text('The exact Brain rule.')
            config = {'workspace': 'w', 'vars': {'BRAIN_ROOT': str(brain), 'MANUALS_ROOT': str(manuals), 'BRAIN_EXCLUDE': 'obsolete'}}
            node = lambda address, revision: {'address': address, 'kind': 'source', 'current_revision': revision,
                                              'document': {'data': {'body': 'The current Source rule.'}}}
            research = {'searches': {'joppa': 'q', 'brain': 'q', 'manuals': 'q'}, 'unavailable': [],
                        'sources': [{'address': 'source:a', 'revision': 2, 'quote': 'An invented rule.'},
                                    {'address': 'source:b', 'revision': 1, 'quote': 'The current Source rule.'}],
                        'files': [{'path': str(policy), 'quote': 'A paraphrase of the rule.'}]}
            values = {'input.json': {}, 'draft.json': {'outcome': 'READY', 'new_sources': [], 'research': research},
                      'decider-assignment.json': {}}
            written = {}
            def require(ok, message):
                if not ok: raise ValueError(message)
            helpers = (lambda: root, lambda config: None, lambda: config, None,
                       lambda api, workspace, address: node(address, 2), None,
                       lambda file: copy.deepcopy(values[file.name]), lambda file, value: written.update({file.name: value}),
                       require, None)
            with patch.object(context, 'native', return_value=helpers), patch.object(sys, 'argv', ['context.py', 'freeze']), \
                    patch.object(context, 'assignment') as save:
                context.main()
                save.assert_not_called()
                issues = written['freeze-issues.json']
                self.assertEqual(len(issues), 3)
                self.assertIn('source:a: the exact quote is absent from the Source body: An invented rule.', issues)
                self.assertIn('source:b: revision 1 is not the current revision 2', issues)
                self.assertIn(str(policy) + ': the exact quote is absent from the file: A paraphrase of the rule.', issues)
                research['sources'] = [{'address': 'source:b', 'revision': 2, 'quote': 'The current Source rule.'}]
                research['files'] = [{'path': str(policy), 'quote': 'The exact Brain rule.'}]
                written.clear(); context.main()
                save.assert_called_once(); self.assertNotIn('freeze-issues.json', written)

    def test_full_requirement_all_34_siblings_and_32_notes_reuse_native_pagination(self):
        api = API()
        value = context.collect(api, {'workspace': 'fixture'}, {'address': 'ac:selected', 'document': {'parent': 'requirement:r'}}, pages, object_read)
        self.assertEqual(len(value['sibling_acs']), 34)
        for node in [value['requirement'], *value['sibling_acs']]:
            self.assertEqual(node['document']['data']['all_fields'], {'retained': True})
            self.assertEqual(len(node['annotations']['comments']), 32)
            self.assertIn('Complete note 31', node['annotations']['comments']['31']['text'])
        self.assertTrue(all(tool == 'joppa_objects' for tool, _ in api.calls))
        self.assertTrue(any(args.get('comments_cursor') == '25' for _, args in api.calls))
        before = value['sibling_acs'][0]
        after = copy.deepcopy(before)
        after['current_revision'] = 99; after['document']['revision'] = 99
        after['document']['data'].update(stage='to_audit', assignee='other-worker')
        types = {'ac': {'role': 'ac'}}
        self.assertEqual(context.authored(before, types, 'ac:selected', snapshot_source), context.authored(after, types, 'ac:selected', snapshot_source))
        after['document']['data']['body'] = 'A changed rule'
        self.assertNotEqual(context.authored(before, types, 'ac:selected', snapshot_source), context.authored(after, types, 'ac:selected', snapshot_source))

    def test_file_evidence_and_large_escaped_assignment_preserve_literal_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); brain = root / 'brain'; manuals = root / 'manuals'; brain.mkdir(); manuals.mkdir()
            config = {'vars': {'BRAIN_ROOT': str(brain), 'MANUALS_ROOT': str(manuals), 'BRAIN_EXCLUDE': 'obsolete'}}
            file = brain / 'policy.md'; literal = '{{file:/must-not-read}} {{var:secret}} </signal:var> Привет 🧪'
            file.write_text('a' * 120000 + literal)
            frozen = context.evidence_file({'path': str(file), 'quote': literal}, config)
            self.assertEqual(frozen['text'], file.read_text()); self.assertEqual(len(frozen['sha256']), 64)
            def run(args, **kwargs):
                return subprocess.check_output(args, text=True, **kwargs)
            context.assignment(root, {'file': frozen, 'extra_data': {'keep': True}}, run)
            encoded = (root / 'decider-assignment.json').read_text()
            self.assertNotIn('{{', encoded)
            self.assertEqual(json.loads(encoded), {'file': frozen, 'extra_data': {'keep': True}})
            excluded = brain / 'obsolete'; excluded.mkdir(); (excluded / 'old.md').write_text(literal)
            for item in [{'path': str(excluded / 'old.md'), 'quote': literal}, {'path': str(file), 'quote': 'missing'}]:
                with self.assertRaises(ValueError): context.evidence_file(item, config)

    def test_reader_permits_only_source_reads_and_rejects_mutations_or_other_workspaces(self):
        class Backend:
            def tools(self):
                return [{'name': name, 'inputSchema': {'properties': {}}} for name in ('joppa_search', 'joppa_objects', 'joppa_batch')]
            def call(self, tool, args):
                return {'tool': tool, 'args': args}
        value = reader.Sources(Backend(), 'fixture', None)
        self.assertEqual([tool['name'] for tool in value.tools()], ['joppa_search', 'joppa_objects', 'read_document'])
        self.assertEqual(value.call('joppa_search', {'query': 'rule'})['args']['kind'], 'source')
        for tool, args in [('joppa_batch', {}), ('joppa_objects', {'address': 'ac:other'}),
                           ('joppa_search', {'workspace': 'foreign'}), ('joppa_search', {'all_workspaces': True})]:
            with self.assertRaises(ValueError): value.call(tool, args)


if __name__ == '__main__':
    unittest.main()
