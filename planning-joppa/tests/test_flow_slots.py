"""Run slot normalization, launch snapshots and real prepare against a tracker fixture."""
from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_configured_flow import ROOT, Tracker, flow_launch, flow_stages, read, write
from provider_fixture import item
import flow_runtime


class FlowSlotTests(unittest.TestCase):
    def test_each_slot_claims_only_its_data_scope_from_the_frozen_effective_config(self):
        for index, label, own, foreign in [(0, 'A', 'alpha', 'beta'), (1, 'B', 'beta', 'alpha')]:
            for wrong_item in (False, True):
                with self.subTest(slot=label, wrong_item=wrong_item), tempfile.TemporaryDirectory() as folder:
                    root = Path(folder)
                    api = Tracker()
                    api.nodes['criterion:a']['document']['data'].update(repository=own, delivery={'state': 'pending'})
                    api.nodes['criterion:b'] = item('criterion:b', data={'repository': foreign, 'delivery': {'state': 'pending'}})
                    config = {'workspace': 'example', 'url': api.url, 'runs_folder': str(root / 'runs'),
                              'workflow': str(ROOT / 'writer/workflow.yaml'), 'mcp_command': ['connector'],
                              'selection': {'kind': 'criterion', 'data': {'delivery': {'state': 'pending'}}},
                              'slots': [{'label': 'A', 'data': {'repository': 'alpha'}},
                                        {'label': 'B', 'data': {'repository': 'beta'}}],
                              'publication': {'file': 'operations.json'}}
                    path = root / 'config.json'
                    write(path, config)

                    def execute(command, env, cwd, effective):
                        variables = dict(value.split('=', 1) for position, value in enumerate(command)
                                         if command[position - 1] == '--var')
                        self.assertEqual(effective['slot'], label)
                        self.assertEqual(effective['selection']['data'], {'delivery': {'state': 'pending'}, 'repository': own})
                        self.assertNotIn('inputs', effective)
                        self.assertNotIn('slots', effective)
                        self.assertEqual(read(variables['PLANNING_JOPPA_CONFIG']), effective)
                        write(path, {'selection': {'data': {'repository': foreign}}})
                        run = root / 'runs' / 'one'
                        with patch.dict(os.environ, {**variables, 'MEDULLA_RUN_DIR': str(run),
                                                     'FLOW_ASSIGNMENT_INLINE': 'false'}), \
                                patch.object(flow_stages, 'client', return_value=api), redirect_stdout(StringIO()):
                            if wrong_item:
                                with self.assertRaisesRegex(ValueError, 'object data differs'):
                                    flow_stages.prepare()
                                self.assertEqual(api.batches, [])
                            else:
                                flow_stages.prepare()
                                assignment = read(run / 'artifacts/input.json')
                                self.assertEqual(assignment['slot'], label)
                                self.assertEqual(assignment['input'], index)
                                self.assertEqual(assignment['selected']['document']['data']['repository'], own)
                                self.assertEqual(len(api.batches), 1)
                                self.assertIsNone(api.nodes['criterion:b']['document']['data'].get('assignee'))
                        return 0

                    with patch.dict(os.environ, {'PLANNING_JOPPA_INPUT': str(index)}), \
                            patch.object(flow_launch.shutil, 'which', return_value='medulla'), \
                            patch.object(flow_runtime, 'execute', side_effect=execute):
                        self.assertEqual(flow_launch.launch(path, json.dumps(config),
                                                           'criterion:b' if wrong_item else 'criterion:a', False), 0)

    def test_slots_and_legacy_inputs_cannot_mix(self):
        with self.assertRaisesRegex(ValueError, 'slots or inputs'):
            flow_launch.configuration('unused', json.dumps({'slots': [], 'inputs': []}))
