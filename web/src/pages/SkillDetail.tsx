import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { apiGet } from '@/api/client';
import type { SkillDetail as View } from '@/api/types';
import { ComparisonBadge } from '@/components/badges';
import { DiffBlock } from '@/components/diff';
import { Loading, LoadError, Page, PageTitle } from '@/components/layout';
import { ProfileChip, SideText, SummaryText } from '@/components/profile';
import { useResource } from '@/lib/useResource';
import { cn } from '@/lib/cn';

export function SkillDetail() {
  const { skill = '' } = useParams();
  const [params] = useSearchParams();
  const a = params.get('a') ?? '', b = params.get('b') ?? '';
  const item = params.get('item') ?? undefined;
  const view = useResource(() => apiGet<View>(`/api/compare/setups/skills/${encodeURIComponent(skill)}`, { a, b, item }), `${skill}|${a}|${b}|${item ?? ''}`);
  const [current, setCurrent] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const data = view.data;
  const back = `/compare/setups?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  return (
    <Page current="compare" title={`${skill} package`}>
      <PageTitle breadcrumb={[{ label: 'Compare', to: '/' }, { label: 'Compare setups', to: back }, { label: 'Skills' }]}
        title={<span className="inline-flex flex-wrap items-center gap-3"><span className="font-mono">{skill}</span>{data ? <ComparisonBadge label={data.label} /> : null}</span>} />
      {view.error ? <LoadError error={view.error} onRetry={view.reload} /> : null}
      {view.loading && !data ? <Loading label="Reading both packages…" /> : null}
      {data ? (
        <>
          <div className="flex flex-wrap items-center gap-3"><ProfileChip side="a" name={data.a.name} /><span className="hint">vs</span><ProfileChip side="b" name={data.b.name} /></div>
          {data.source ? <p className="meta">{data.source}</p> : null}
          <p className="text-body">{data.coverage}</p>
          <p className="hint">{data.toolsNote}</p>
          <div className="flex flex-wrap gap-6 items-start">
            <nav aria-label="Files" className="panel p-0 overflow-hidden" style={{ flex: '1 1 260px' }}>
              <h2 className="panel-head text-body font-semibold" style={{ borderRadius: 0 }}>Files</h2>
              <ul className="list-none p-0">
                {data.files.map((file, index) => (
                  <li key={file.path}>
                    <a href={`#file-${index}`} aria-current={index === current ? 'true' : undefined} onClick={() => setCurrent(index)}
                      className="row-select no-underline flex-col gap-1" data-selected={index === current} style={{ color: 'var(--color-text)' }}>
                      <span className={cn('font-mono text-ui wrap-anywhere', file.label === 'different' ? 'font-semibold' : 'muted')}>{file.path}</span>
                      <span className="hint">{file.label === 'same' ? 'Same' : file.label === 'cannot-compare' ? <>Could not compare · <SummaryText parts={file.summary} colored={false} /></> : <>Different · <SummaryText parts={file.summary} colored /></>}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex flex-col gap-4" style={{ flex: '999 1 520px', minWidth: 0 }}>
              {data.files.map((file, index) => (
                <article key={file.path} id={`file-${index}`} className="panel flex flex-col gap-3" aria-labelledby={`file-title-${index}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 id={`file-title-${index}`} className="font-mono text-body font-semibold wrap-anywhere">{file.path}</h3>
                    <ComparisonBadge label={file.label} /><span className="hint">{file.exactText}</span>
                  </div>
                  {file.diff ? <DiffBlock lines={file.diff} a={data.a.name} b={data.b.name} label={`Differences in ${file.path}`} /> : null}
                  {file.statement ? <p className="text-ui">{file.statement}</p> : null}
                  {file.only ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-ui">Only in <SideText side={file.only.side}>{file.only.side === 'a' ? data.a.name : data.b.name}</SideText></p>
                      <pre className={cn('code-block', file.only.side === 'a' ? 'edge-a' : 'edge-b')}>{(expanded[file.path] ? file.only.lines : file.only.lines.slice(0, 12)).join('\n')}</pre>
                      {file.only.lines.length > 12 ? <button type="button" className="btn btn-link self-start" aria-expanded={Boolean(expanded[file.path])}
                        onClick={() => setExpanded(value => ({ ...value, [file.path]: !value[file.path] }))}>{expanded[file.path] ? 'Show fewer lines' : `Show ${file.only.lines.length - 12} more lines`}</button> : null}
                    </div>
                  ) : null}
                  {file.label === 'same' ? <p className="hint">Same in both profiles.</p> : null}
                </article>
              ))}
            </div>
          </div>
          {data.copy ? (
            <section className="panel flex flex-col gap-3" aria-labelledby="make-match">
              <h2 id="make-match" className="text-heading">Make one side match?</h2>
              <p className="text-ui">This page changes nothing. Copying opens a preview first. The whole skill is replaced so it matches exactly, never merged, and you can undo it.</p>
              <ul className="text-ui list-disc pl-5 flex flex-col gap-1">
                <li>{data.copy.aToB}</li>
                <li>{data.copy.bToA}</li>
              </ul>
              <div className="flex flex-wrap gap-2">
                <Link className="btn btn-primary" to={data.copy.href}>{data.copy.label}</Link>
                <Link className="btn" to={back}>Back to setup comparison</Link>
              </div>
            </section>
          ) : <Link to={back}>Back to setup comparison</Link>}
        </>
      ) : null}
    </Page>
  );
}
