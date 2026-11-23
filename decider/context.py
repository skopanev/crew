"""Freeze read-only decision evidence. Keep publication in the shared flow stage."""
import copy
import json
import os
from pathlib import Path
import sys
from documents import read_document, research_roots


def native():
    runtime = Path(os.environ['CREW_FLOW_STAGES']).resolve().parent
    sys.path.insert(0, str(runtime))
    sys.path.insert(1, str(runtime.parent / 'planning'))
    from flow_stages import artifacts, client, settings
    from flow_context import pages
    from context_reads import object_read
    from context_snapshot import snapshot_source
    from common import read, write, require, run
    return artifacts, client, settings, pages, object_read, snapshot_source, read, write, require, run


def collect(api, config, selected, pages, full):
    parent = selected['document']['parent']
    requirement = full(api, config['workspace'], parent)
    siblings = []
    query = {'kind': 'ac', 'parent': parent, 'depth': 1, 'fields': ['revision', 'parent'],
             'status': ['red', 'yellow', 'orange', 'blue', 'green']}
    for row in pages(api, config['workspace'], query):
        if row['address'] == selected['address']:
            continue
        node = full(api, config['workspace'], row['address'])
        if node['document']['parent'] != parent:
            raise ValueError('Sibling parent changed during its read')
        siblings.append(node)
    return {'requirement': requirement, 'sibling_acs': sorted(siblings, key=lambda node: node['address'])}


def authored(node, types, selected, snapshot):
    value = copy.deepcopy(snapshot(node, types, [selected]))
    value.get('document', {}).get('data', {}).pop('stage', None)
    return value


def evidence_file(item, config):
    document = read_document(item['path'], config)
    if not item.get('quote') or item['quote'] not in document['text']:
        raise ValueError('The exact file quote is absent')
    return document


def assignment(target, value, run):
    # Use the Writer and Auditor JSON escape, without a context limit or projection of evidence.
    text = run(['jq', '-r', r'tojson | gsub("\\{\\{"; "\\u007b\\u007b")'], input=json.dumps(value, ensure_ascii=False))
    temporary = target / 'decider-assignment.json.tmp'
    temporary.write_text(text)
    temporary.replace(target / 'decider-assignment.json')


def main():
    artifacts, client, settings, pages, full, snapshot, read, write, require, run = native()
    target, config = artifacts(), settings()
    base = read(target / 'input.json')
    command = sys.argv[1]
    api = None
    def connection():
        nonlocal api
        api = api or client(config)
        return api
    try:
        research_roots(config)
        if command == 'prepare':
            if 'requirement' in base and 'sibling_acs' in base:
                context = {key: base[key] for key in ('requirement', 'sibling_acs')}
            else:
                context = collect(connection(), config, base['selected'], pages, full)
            require(context['requirement']['document']['present'] is True, 'The Requirement is absent')
            write(target / 'decider-context.json', context)
            value = {**base, **context, 'children': [], 'research_evidence': {'sources': [], 'files': []}}
            for key in ('help', 'claim_revision', 'claim_revisions'):
                value.pop(key, None)
            assignment(target, value, run)
            reader = Path(__file__).with_name('reader.py').resolve()
            mcp = {'mcpServers': {'sources': {'command': sys.executable, 'args': [str(reader)],
                   'env': {key: os.environ[key] for key in ('CREW_FLOW_STAGES', 'PLANNING_JOPPA_CONFIG')}}}}
            write(target / 'reader-mcp.json', mcp)
            print(f'<signal:var key=decider_assignment_path>{target / "decider-assignment.json"}</signal:var>')
            print(f'<signal:var key=DECIDER_MCP_CONFIG>{target / "reader-mcp.json"}</signal:var>')
        elif command == 'freeze':
            draft = read(target / 'draft.json')
            research = draft['research']
            require(not research.get('unavailable'), 'SEARCH_UNAVAILABLE: a research route failed')
            require(set(research['searches']) == {'joppa', 'brain', 'manuals'} and
                    all(isinstance(query, str) and query.strip() for query in research['searches'].values()),
                    'SEARCH_UNAVAILABLE: all three routes need their actual search queries')
            sources = []
            for item in research.get('sources', []):
                node = full(connection(), config['workspace'], item['address'])
                require(node['kind'] == 'source' and node['current_revision'] == item['revision'], 'Source revision changed')
                require(item['quote'] in node['document']['data'].get('body', ''), 'The exact Source quote is absent')
                sources.append(node)
            files = {}
            for item in [*research.get('files', []), *draft.get('new_sources', [])]:
                frozen = evidence_file(item, config)
                files[frozen['path']] = frozen
            value = read(target / 'decider-assignment.json')
            value['research_evidence'] = {'sources': sources, 'files': list(files.values()), 'searches': research['searches']}
            assignment(target, value, run)
        elif command == 'verify':
            value = read(target / 'decider-assignment.json')
            previous = read(target / 'decider-context.json')
            current = collect(connection(), config, base['selected'], pages, full)
            types, selected = base['schema']['types'], base['selected']['address']
            for group in ('requirement', 'sibling_acs'):
                before = previous[group] if group == 'sibling_acs' else [previous[group]]
                after = current[group] if group == 'sibling_acs' else [current[group]]
                require([authored(item, types, selected, snapshot) for item in before] ==
                        [authored(item, types, selected, snapshot) for item in after], 'Authored Requirement or sibling context changed')
            for node in value['research_evidence']['sources']:
                current = full(connection(), config['workspace'], node['address'])
                require(snapshot(node, types, [selected]) == snapshot(current, types, [selected]), 'Discovered Source changed')
            for item in value['research_evidence']['files']:
                require(evidence_file({'path': item['path'], 'quote': item['text']}, config)['sha256'] == item['sha256'],
                        'A frozen evidence file changed')
        else:
            raise ValueError('Use prepare, freeze or verify')
    finally:
        if api and api.stdio:
            api.stdio.close()


if __name__ == '__main__':
    main()
