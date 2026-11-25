"""A parent note needs its preceding guarded stage save in the same native batch."""
from copy import deepcopy
from unittest.mock import patch

from test_flow_inputs import InputFixture, flow_publication, read, Rejected


class ParentNoteTests(InputFixture):
    def output(self):
        return {'operations': [
            {'command': {'op': 'save_object', 'kind': 'criterion', 'id': 'a', 'revision': 4,
                         'data': {'stage': 'waiting'}, 'reason': 'The parent needs a decision.'}},
            {'command': {'op': 'note', 'target': 'criterion:a', 'id': 'findings', 'text': 'The critic findings.'}}]}

    def test_guarded_parent_save_note_and_claim_release_share_one_batch(self):
        self.publish(self.output())
        rows = self.api.batches[-1]['operations']
        self.assertEqual(rows[0]['command']['kind'], 'criterion')
        self.assertEqual(rows[1]['ref'], 'flow_release')
        self.assertEqual(rows[2]['command'], self.output()['operations'][1]['command'])
        self.assertEqual(self.api.nodes['criterion:a']['document']['data']['stage'], 'waiting')
        self.assertIsNone(self.api.nodes['work:t']['document']['data'].get('assignee'))
        self.assertEqual(read(self.target / 'publication.json')['status'], 'confirmed')

    def test_missing_save_wrong_order_scope_permission_and_stale_revision_are_refused(self):
        for mode in ('missing', 'order', 'incoming', 'unrelated', 'permission', 'kind', 'note_permission', 'stale', 'body'):
            output, config = self.output(), deepcopy(self.config)
            if mode == 'missing': output['operations'].pop(0)
            if mode == 'order': output['operations'].reverse()
            if mode == 'incoming': output['operations'][1]['command']['target'] = 'work:consumer'
            if mode == 'unrelated': output['operations'][1]['command']['target'] = 'source:s'
            if mode == 'permission': config['publication']['related_updates'].pop('parent')
            if mode == 'kind': config['publication']['update_kinds'].remove('criterion')
            if mode == 'note_permission': config['publication']['allowed_operations'].remove('note')
            if mode == 'stale': output['operations'][0]['command']['revision'] = 3
            if mode == 'body': output['operations'][0]['command']['data'] = {'body': 'Unrelated change'}
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                flow_publication.operations(config, self.assignment, self.claim, output)
        self.assertEqual(len(self.api.batches), 1)

    def test_held_parent_and_native_revision_race_keep_the_note_unpublished(self):
        call = self.api.call
        def race(tool, args):
            if tool == 'joppa_batch':
                self.api.nodes['criterion:a']['current_revision'] += 1
            return call(tool, args)
        with patch.object(self.api, 'call', side_effect=race), self.assertRaises(Rejected):
            self.publish(self.output())
        self.assertEqual(len(self.api.batches), 1)
        self.assertNotIn('stage', self.api.nodes['criterion:a']['document']['data'])
        self.api.nodes['criterion:a']['document']['data']['assignee'] = 'other'
        with self.assertRaises(ValueError):
            self.publish(self.output())
        self.assertEqual(len(self.api.batches), 1)

    def test_parent_notes_still_count_towards_the_native_batch_limit(self):
        output = self.output()
        output['operations'].extend({'command': {'op': 'note', 'target': 'criterion:a', 'id': str(index), 'text': 'Finding'}}
                                    for index in range(98))
        with self.assertRaisesRegex(ValueError, 'one native batch'):
            self.publish(output)
        self.assertEqual(len(self.api.batches), 1)
