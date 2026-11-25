"""Configured modules filter every flow input before the native claim."""
from contextlib import redirect_stderr
from io import StringIO
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_flow_batch import AtomicTracker, flow_stages, read


class FlowAdmissionTests(unittest.TestCase):
    def test_rejected_batch_members_are_not_claimed(self):
        with tempfile.TemporaryDirectory() as folder:
            root, api = Path(folder), AtomicTracker()
            module = root / 'admission.mjs'
            module.write_text('export const admission=row=>{console.error("ADMISSION_SKIP "+JSON.stringify({address:row.address}));return row.address!=="work:t2";};')
            config = {'workspace': 'example', 'url': api.url, 'runs_folder': str(root),
                      'selection': {'kind': 'work'}, 'batch': {'size': 3, 'by': 'data.repository'},
                      'admission_module': str(module), 'publication': {'file': 'operations.json'}}
            diagnostics = StringIO()
            with redirect_stderr(diagnostics), \
                    patch.dict(os.environ, {'MEDULLA_RUN_DIR': str(root / 'run'), 'PLANNING_JOPPA_ITEM': 'work:t1'}), \
                    patch.object(flow_stages, 'settings', return_value=config), \
                    patch.object(flow_stages, 'client', return_value=api), patch.object(flow_stages, 'emit'):
                flow_stages.prepare()
            self.assertIn('ADMISSION_SKIP {"address":"work:t2"}', diagnostics.getvalue())
            assignment = read(root / 'run/artifacts/input.json')
            self.assertEqual([row['address'] for row in assignment['items']], ['work:t1', 'work:t3'])
            self.assertIsNone(api.nodes['work:t2']['document']['data'].get('assignee'))
            self.assertEqual(len(api.batches), 1)

    def test_rejected_anchor_or_module_failure_stops_before_any_claim(self):
        for batch in (None, {'size': 3}):
            for body in ('export const admission=()=>false;', 'export const admission=()=>"yes";'):
                with self.subTest(batch=batch, body=body), tempfile.TemporaryDirectory() as folder:
                    root, api = Path(folder), AtomicTracker()
                    module = root / 'admission.mjs'; module.write_text(body)
                    config = {'workspace': 'example', 'url': api.url, 'runs_folder': str(root),
                              'selection': {'kind': 'work'}, 'admission_module': str(module)}
                    if batch:
                        config['batch'] = batch
                    with patch.dict(os.environ, {'MEDULLA_RUN_DIR': str(root / 'run'), 'PLANNING_JOPPA_ITEM': 'work:t1'}), \
                            patch.object(flow_stages, 'settings', return_value=config), \
                            patch.object(flow_stages, 'client', return_value=api), self.assertRaises(ValueError):
                        flow_stages.prepare()
                    self.assertEqual(api.batches, [])
