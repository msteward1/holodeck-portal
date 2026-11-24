import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Search, ServerCog, ShieldCheck } from 'lucide-react';
import { useApi } from '../lib/hooks';
import { ErrorNote, PageHeader, Spinner } from '../components/ui';

/**
 * The Documentation tab. The guides are standalone HTML files in the repository's docs/ folder
 * (served by /api/docs/:guide); this page shows their sections as a tree. The administrator
 * guide is only listed for (and served to) administrators.
 */

type GuideId = 'user' | 'admin' | 'ops';

interface DocSection {
  id: string;
  title: string;
  group: string;
  icon: string;
  html: string;
  text: string;
}

interface Guide {
  id: GuideId;
  title: string;
  css: string;
  sections: DocSection[];
}

function parseGuide(id: GuideId, title: string, html: string): Guide {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const icons = new Map<string, string>();
  doc.querySelectorAll<HTMLElement>('.navlink').forEach((b) => icons.set(b.dataset.target ?? '', b.querySelector('svg')?.outerHTML ?? ''));
  const sections = [...doc.querySelectorAll<HTMLElement>('section.section')].map((s) => ({
    id: s.id,
    title: s.dataset.title ?? s.id,
    group: s.dataset.group ?? '',
    icon: icons.get(s.id) ?? '',
    html: s.innerHTML,
    text: (s.textContent ?? '').toLowerCase(),
  }));
  return { id, title, css: doc.getElementById('hp-doc-content')?.textContent ?? '', sections };
}

function useGuides() {
  const list = useApi<{ guides: { id: GuideId; title: string }[] }>('/api/docs');
  const [guides, setGuides] = useState<Guide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!list.data) return;
    let cancelled = false;
    Promise.all(
      list.data.guides.map(async (g) => {
        const res = await fetch(`/api/docs/${g.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Could not load the ${g.title.toLowerCase()} (HTTP ${res.status})`);
        return parseGuide(g.id, g.title, await res.text());
      }),
    )
      .then((gs) => !cancelled && setGuides(gs))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [list.data]);
  return { guides, error: error ?? list.error };
}

const guideIcon = { user: BookOpen, admin: ShieldCheck, ops: ServerCog };

export function Help() {
  const { guide: guideParam, section: sectionParam } = useParams();
  const navigate = useNavigate();
  const { guides, error } = useGuides();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const guide = guides?.find((g) => g.id === guideParam) ?? guides?.[0];
  const section = guide?.sections.find((s) => s.id === sectionParam) ?? guide?.sections[0];
  const go = (g: GuideId, s: string) => navigate(`/help/${g}/${s}`);

  // New section: start at the top of the page.
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 });
  }, [guide?.id, section?.id]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (s: DocSection) => words.every((w) => s.text.includes(w) || s.title.toLowerCase().includes(w));
  const flat = useMemo(() => (guides ?? []).flatMap((g) => g.sections.map((s) => ({ g, s }))), [guides]);
  const index = flat.findIndex((x) => x.g.id === guide?.id && x.s.id === section?.id);
  const prev = index > 0 ? flat[index - 1] : null;
  const next = index >= 0 && index < flat.length - 1 ? flat[index + 1] : null;

  // Links between sections, and copy buttons on code blocks, inside the guide's HTML.
  const onContentClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>('a[data-goto]');
    if (link && guide) {
      e.preventDefault();
      // data-guide: a section of another guide (only listed guides can be opened).
      const other = link.dataset.guide as GuideId | undefined;
      go(other && guides?.some((g) => g.id === other) ? other : guide.id, link.dataset.goto!);
      return;
    }
    const copy = target.closest<HTMLButtonElement>('button.copy');
    if (copy) {
      const text = copy.parentElement?.querySelector('pre')?.innerText.trim() ?? '';
      const done = () => {
        copy.textContent = 'Copied';
        copy.classList.add('done');
        setTimeout(() => {
          copy.textContent = 'Copy';
          copy.classList.remove('done');
        }, 1600);
      };
      void navigator.clipboard?.writeText(text).then(done, done);
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!guides || !guide || !section) return <Spinner className="mx-auto size-6" />;

  return (
    <div>
      <style>{guides[0].css}</style>
      <PageHeader
        title="Documentation"
        subtitle="How to use the Holodeck Portal and how to run it."
        actions={guides.map((g) => (
          <a key={g.id} className="btn-secondary" href={`/api/docs/${g.id}`} target="_blank" rel="noreferrer" title={`Open the ${g.title.toLowerCase()} as a single page`}>
            <ExternalLink className="size-4" /> {g.title}
          </a>
        ))}
      />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside className="panel shrink-0 p-3 lg:sticky lg:top-0 lg:max-h-[calc(100vh-4rem)] lg:w-72 lg:overflow-y-auto">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-500" />
            <input
              className="input pl-8"
              placeholder="Search the documentation…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const hit = flat.find((x) => matches(x.s));
                if (hit) go(hit.g.id, hit.s.id);
              }}
            />
          </div>
          {guides.map((g) => {
            const Icon = guideIcon[g.id];
            const visible = g.sections.filter(matches);
            const open = words.length > 0 || !collapsed[g.id];
            const groups = [...new Set(visible.map((s) => s.group))];
            return (
              <div key={g.id} className="mb-1">
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-white hover:bg-ink-700"
                  onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}
                >
                  <Icon className="size-4 text-blue-300" />
                  <span className="flex-1">{g.title}</span>
                  {words.length > 0 && <span className="text-xs font-normal text-slate-500">{visible.length}</span>}
                  <ChevronDown className={`size-4 text-slate-500 transition ${open ? '' : '-rotate-90'}`} />
                </button>
                {open && (
                  <div className="ml-2 border-l border-ink-700 pl-2">
                    {groups.map((group) => (
                      <div key={group}>
                        <div className="label-caps mt-3 mb-1 px-2">{group}</div>
                        {visible
                          .filter((s) => s.group === group)
                          .map((s) => {
                            const active = g.id === guide.id && s.id === section.id;
                            return (
                              <button
                                key={s.id}
                                onClick={() => go(g.id, s.id)}
                                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition [&_svg]:size-4 [&_svg]:shrink-0 ${
                                  active ? 'bg-accent-soft/60 text-blue-300 ring-1 ring-accent/30' : 'text-slate-300 hover:bg-ink-700 hover:text-white'
                                }`}
                              >
                                <span className={active ? 'text-blue-300' : 'text-slate-500'} dangerouslySetInnerHTML={{ __html: s.icon }} />
                                <span className="truncate">{s.title}</span>
                              </button>
                            );
                          })}
                      </div>
                    ))}
                    {visible.length === 0 && <p className="px-2 py-2 text-xs text-slate-500">No matches.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        <article className="panel min-w-0 flex-1 p-6 lg:p-8">
          <div className="mb-4 flex items-center gap-2 text-xs text-slate-500">
            <span>{guide.title}</span>
            <ChevronRight className="size-3" />
            <span>{section.group}</span>
            <ChevronRight className="size-3" />
            <span className="text-slate-300">{section.title}</span>
          </div>
          {/* The guides are this repository's own files, served by the portal. */}
          <div className="hp-doc" onClick={onContentClick} dangerouslySetInnerHTML={{ __html: section.html }} />
          <div className="mt-10 flex items-center justify-between gap-4 border-t border-ink-700 pt-4">
            {prev ? (
              <button className="btn-ghost" onClick={() => go(prev.g.id, prev.s.id)}>
                <ChevronLeft className="size-4" /> {prev.s.title}
              </button>
            ) : (
              <span />
            )}
            {next && (
              <button className="btn-ghost" onClick={() => go(next.g.id, next.s.id)}>
                {next.g.id !== guide.id ? `${next.g.title}: ` : ''}
                {next.s.title} <ChevronRight className="size-4" />
              </button>
            )}
          </div>
        </article>
      </div>
    </div>
  );
}
