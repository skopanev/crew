"""Focused provider checks. No network, credentials, or live mutations."""
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "planning"))
sys.path.insert(0, str(ROOT / "planning-joppa"))
from common import read
import context
from mcp import MCPError, Rejected, Reader
import publication


from provider_fixture import item, assignment, plan, Fake


class ProviderTests(unittest.TestCase):
    def test_title_limit_uses_the_current_schema_name_and_keeps_the_older_name(self):
        data, value = assignment(), plan()
        value['tasks'][0]['title'] = 'x' * 90
        data['joppa']['task_schema'].update(title_max_length=128, title_preview_length=64)
        publication.operations(value, data)
        data['joppa']['task_schema']['title_max_length'] = 80
        with self.assertRaisesRegex(ValueError, 'configured 80-character limit'):
            publication.operations(value, data)
        del data['joppa']['task_schema']['title_max_length']
        with self.assertRaisesRegex(ValueError, 'configured 64-character limit'):
            publication.operations(value, data)

    def test_new_contract_fields_keep_the_full_mechanism_within_each_value_limit(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task['steps'] = ['Preserve the required behavior. ' + '🙂' * 240] * 5
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertEqual(saved['contract'], 'Goal: ' + task['outcome'])
        self.assertEqual(saved['steps'], task['steps'])
        self.assertGreater(len(context.task_contract(saved)), 1024)
        for key in ('contract', 'repository', 'module', 'steps', 'checks'):
            for entry in saved[key] if isinstance(saved[key], list) else [saved[key]]:
                self.assertLessEqual(len(entry), 1024)

    def test_contract_value_limits_fail_before_publication_without_truncation(self):
        for field, size in (('outcome', 1018), ('step', 1024), ('check', 1024)):
            for extra in (0, 1):
                with self.subTest(field=field, extra=extra):
                    data, value = assignment(), plan()
                    task = value['tasks'][0]
                    if field == 'outcome':
                        task['outcome'] = '🙂' * (size + extra)
                    elif field == 'step':
                        task['steps'] = ['🙂' * (size + extra)]
                    else:
                        task['checks'] = [{'scenario': 'x', 'expected': '🙂' * (size + extra - 5)}]
                        value['acceptance_checks'] = [{'repository': 'service', **task['checks'][0]}]
                    before = deepcopy(value)
                    if extra:
                        with self.assertRaisesRegex(ValueError, 'use at most 1024; no text was truncated'):
                            publication.operations(value, data)
                    else:
                        publication.operations(value, data)
                    self.assertEqual(value, before)

    def test_unchanged_long_inline_contract_is_not_migrated_by_a_link_update(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task.update(action='update', target='work:old', revision=3, steps=['x' * 1024, 'y' * 1024],
                    depends_on=['work:dependency'])
        old = data['joppa']['tasks'][0]['document']['data']
        old.update(title=task['title'], contract=publication.contract(task, value), projects=['other', 'p'])
        before = deepcopy(old)
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertGreater(len(saved['contract']), 1024)
        self.assertEqual(saved, before)
        self.assertNotIn('steps', saved)
        self.assertEqual(old, before)

    def test_changed_structured_steps_update_a_blocked_task_with_the_same_goal(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task.update(action='update', target='work:old', revision=3)
        old = data['joppa']['tasks'][0]
        old['document']['data'].update(publication.contract_fields(task))
        old['process']['blocked'] = {'reason': 'Failed', 'position': 19}
        task['steps'].append('Handle the recorded failure in the same mechanism.')
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertEqual(saved['contract'], old['document']['data']['contract'])
        self.assertNotEqual(saved['steps'], old['document']['data']['steps'])

    def test_structured_recovery_step_zero_keeps_its_scope_and_order(self):
        data, value = assignment(), plan()
        task = value['tasks'][0]
        task.update(action='update', target='work:old', revision=3)
        task['steps'].insert(0, '0. Resume from the confirmed checkpoint without reapplying it.')
        old = data['joppa']['tasks'][0]['document']['data']
        old.update(publication.contract_fields(task))
        task['steps'].append('Handle the remaining failure within this module.')
        saved = publication.operations(value, data)[0]['command']['data']
        self.assertEqual(saved['steps'][0], old['steps'][0])
        self.assertEqual(context.task_contract(saved).count('\n0. Resume'), 1)
        old['module'] = 'other'
        with self.assertRaisesRegex(ValueError, 'recovery step 0 scope mismatch'):
            publication.operations(value, data)

    def test_pending_work_hydrates_structured_queue_rows_without_a_projection_change(self):
        data, value = assignment(), plan()
        fields = publication.contract_fields(value['tasks'][0])
        obj = item('work:outside', 'criterion:outside', fields)
        calls = []
        class Server:
            def call(self, name, args):
                calls.append((name, args))
                if name == 'joppa_tasks':
                    return {'tasks': [{'address': obj['address'], 'revision': 3, 'title': 'Outside',
                        'projects': ['p'], 'status': 'open', 'contract': fields['contract']}], 'next_cursor': None}
                self_address = args['address']
                if self_address != obj['address']:
                    raise AssertionError(self_address)
                return deepcopy(obj)
        result = context.pending_work(Server(), {'workspace': 'example', 'repositories': data['repositories']}, data)
        self.assertEqual(result[0]['repository'], 'service')
        self.assertEqual(result[0]['module'], 'core')
        self.assertIn('Use the existing mechanism', result[0]['how'])
        self.assertEqual([name for name, args in calls], ['joppa_tasks', 'joppa_objects'])
