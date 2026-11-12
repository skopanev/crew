"""Selected and historical reads keep the requested shape and current revision fence."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
import context
from mcp import MCPError, Reader, Joppa
from provider_fixture import item, Fake


class ReaderSelectionTests(unittest.TestCase):
    def test_selected_agent_reads_are_fenced_by_the_injected_revision(self):
        full = item('work:a', 'criterion:a', {'title': 'Current', 'body': 'New contract', 'spec': {'step': 'one'}},
                    process={'verification': 'pass'})
        current, calls, revision = full['current_revision'], [], [full['current_revision']]
        class Server(Fake):
            def raw_call(self, name, args):
                calls.append(deepcopy(args))
                # Joppa answers each selected path from one snapshot; the test serves the caller's selection.
                values = {'body': 'New contract', 'title': 'Current', 'data.spec.step': 'one',
                          'process.verification': 'pass', 'revision': revision[-1]}
                return {key: values.get(key) for key in args['fields']}
        reader = Reader(Server(result=full), 'example', Path('/unused'))
        with patch.object(context, 'capture_object') as capture:
            for fields in (['body'], ['title'], ['data.spec.step'], ['process.verification']):
                reply = reader.call('joppa_objects', {'address': 'work:a', 'fields': fields})
                # The fence asks for the revision; the caller gets only what it selected.
                self.assertEqual(calls[-1]['fields'], [*fields, 'revision'])
                self.assertEqual(list(reply), fields)
            asked = reader.call('joppa_objects', {'address': 'work:a', 'fields': ['revision', 'body']})
            self.assertEqual((calls[-1]['fields'], asked['revision']), (['revision', 'body'], current))
            self.assertEqual(capture.call_count, 5)
            # Any own change advances the revision, so a stale selection refuses capture.
            revision.append(current - 1)
            with self.assertRaisesRegex(MCPError, 'changed before its planning snapshot'):
                reader.call('joppa_objects', {'address': 'work:a', 'fields': ['body']})
            self.assertEqual(capture.call_count, 5)

    def test_multiple_addresses_keep_each_selected_reply_and_revision_fence(self):
        objects = {address: item(address, data={'body': address}) for address in ('work:a', 'work:b')}
        calls, stale = [], set()
        class Server(Fake):
            def raw_call(self, name, args):
                calls.append(deepcopy(args))
                address = args['address']
                return {'body': address, 'revision': objects[address]['current_revision'] - (address in stale)}
        reader = Reader(Server(), 'example', Path('/unused'))
        with patch.object(context, 'object_read', side_effect=lambda api, workspace, address: objects[address]), \
                patch.object(context, 'capture_object') as capture:
            reply = reader.call('joppa_objects', {'address': 'work:a,work:b', 'fields': ['body']})
            self.assertEqual(reply, {'items': [{'body': 'work:a'}, {'body': 'work:b'}]})
            self.assertEqual([call['fields'] for call in calls], [['body', 'revision']] * 2)
            self.assertEqual(capture.call_count, 2)
            stale.add('work:b')
            with self.assertRaisesRegex(MCPError, 'changed before its planning snapshot'):
                reader.call('joppa_objects', {'address': 'work:a,work:b', 'fields': ['body']})
            self.assertEqual(capture.call_count, 3)

    def test_current_detail_names_fields_and_a_revision_read_stays_historical(self):
        calls = []
        api = Joppa.__new__(Joppa)
        def raw_call(name, args):
            calls.append(deepcopy(args))
            if args.get('revision'):
                return {'revision': 1, 'current_revision': 5, 'parent': 'ac:a', 'data': {'title': 'Old'}}
            return {'revision': 5, 'parent': 'ac:a', 'data': {'title': 'New'}, 'present': True, 'status': 'green',
                    'status.label': 'Done', 'files': None, 'references': None, 'process': None, 'result': None}
        api.raw_call = raw_call
        old = api.call('joppa_objects', {'workspace': 'w', 'address': 'work:a', 'revision': 1})
        self.assertNotIn('fields', calls[-1])
        self.assertEqual((old['current_revision'], old['historical'], old['document']['data']['title']), (5, True, 'Old'))
        current = api.call('joppa_objects', {'workspace': 'w', 'address': 'work:a'})
        self.assertIn('present', calls[-1]['fields'])
        self.assertNotIn('current_revision', calls[-1]['fields'])
        self.assertEqual((current['current_revision'], current['historical']), (5, False))
        self.assertEqual(current['status'], {'tone': 'green', 'label': 'Done'})
        self.assertEqual((current['files'], current['references'], current['process']), ([], [], {}))
        self.assertNotIn('result', current)
