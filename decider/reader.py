"""Expose the existing read-only Joppa reader for Sources in one workspace."""
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

    def call(self, name, arguments):
        if name == 'read_document':
            if not isinstance(arguments, dict) or set(arguments) != {'path'} or not isinstance(arguments['path'], str):
                raise MCPError('Use one document path inside the approved roots')
            return read_document(arguments['path'], self.config)
        if (not isinstance(arguments, dict) or name not in ('joppa_search', 'joppa_objects') or
                arguments.get('workspace', self.workspace) != self.workspace or arguments.get('all_workspaces')):
            raise MCPError('Only Source reads in the configured workspace are permitted')
        args = {**arguments, 'workspace': self.workspace}
        address = args.get('address')
        if address:
            if not all(part.strip().startswith('source:') for part in address.split(',')):
                raise MCPError('Use source:id addresses')
        else:
            args['kind'] = 'source'
        return super().call(name, args)


if __name__ == '__main__':
    config = json.loads(Path(os.environ['PLANNING_JOPPA_CONFIG']).read_text())
    api = Joppa(config['url'], config.get('token_file'), config.get('mcp_command'))
    try:
        serve(Sources(api, config['workspace'], None, config))
    finally:
        if api.stdio:
            api.stdio.close()
