"""Expose the existing read-only Joppa reader for Sources, and for the MOVE kinds of the selected domain, in one workspace."""
import json
import os
from pathlib import Path
import sys
from documents import read_document

sys.path.insert(0, str(Path(os.environ['CREW_FLOW_STAGES']).resolve().parent))
from mcp import Joppa, Reader, MCPError, serve


class Sources(Reader):
    def __init__(self, api, workspace, target, config=None):
        super().__init__(api, workspace, target)
        self.config = config or {}

    def tools(self):
        return [tool for tool in super().tools() if tool['name'] in ('joppa_search', 'joppa_objects')] + [{
            'name': 'read_document', 'description': 'Read full PDF, DOCX or UTF-8 text inside approved roots, with its raw file SHA256.',
            'inputSchema': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path'], 'additionalProperties': False},
            'annotations': {'readOnlyHint': True, 'destructiveHint': False}}]

    def kinds(self):
        # READER_KINDS: source and the kinds that MOVE needs (requirement, capability). The default stays source.
        return str((self.config.get('vars') or {}).get('READER_KINDS', 'source')).split()

    def scope(self, address):
        # A node of a structural kind is readable only inside config.selection.parent, the domain of the Decider.
        root = (self.config.get('selection') or {}).get('parent')
        if not root:
            raise MCPError('Configure selection.parent for structural reads')
        seen = set()
        while address != root:
            if not isinstance(address, str) or not address or address in seen:
                raise MCPError('Read only nodes inside the selected domain ' + root)
            seen.add(address)
            node = super().call('joppa_objects', {'workspace': self.workspace, 'address': address, 'fields': ['parent']})
            address = node.get('parent', node.get('document', {}).get('parent'))

    def call(self, name, arguments):
        if name == 'read_document':
            if not isinstance(arguments, dict) or set(arguments) != {'path'} or not isinstance(arguments['path'], str):
                raise MCPError('Use one document path inside the approved roots')
            return read_document(arguments['path'], self.config)
        if (not isinstance(arguments, dict) or name not in ('joppa_search', 'joppa_objects') or
                arguments.get('workspace', self.workspace) != self.workspace or arguments.get('all_workspaces')):
            raise MCPError('Only Source and domain reads in the configured workspace are permitted')
        args, kinds = {**arguments, 'workspace': self.workspace}, self.kinds()
        address = args.get('address')
        if address:
            parts = [part.strip() for part in address.split(',')]
            if not all(part.split(':')[0] in kinds for part in parts):
                raise MCPError('Use ' + ', '.join(kind + ':id' for kind in kinds) + ' addresses')
            for part in parts:
                if not part.startswith('source:'):
                    self.scope(part)
        else:
            kind = args.get('kind')
            args['kind'] = kind if isinstance(kind, str) and kind in kinds else 'source'
            if args['kind'] != 'source':
                selection = self.config.get('selection') or {}
                if not args.get('parent'):
                    args['parent'], args['depth'] = selection.get('parent'), args.get('depth', selection.get('depth', 4))
                if args['parent'] == '*':
                    raise MCPError('Read domain nodes under one parent inside the selected domain')
                self.scope(args['parent'])
        return super().call(name, args)


if __name__ == '__main__':
    config = json.loads(Path(os.environ['PLANNING_JOPPA_CONFIG']).read_text())
    api = Joppa(config['url'], config.get('token_file'), config.get('mcp_command'))
    try:
        serve(Sources(api, config['workspace'], None, config))
    finally:
        if api.stdio:
            api.stdio.close()
