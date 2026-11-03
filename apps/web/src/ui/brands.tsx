import { BRANDS } from './brand-data';
import { TECH } from './tech-data';
import { cx } from './kit';

export type Brand = keyof typeof BRANDS;

/** A service's or model provider's logo. Decorative unless given a title. */
export function BrandLogo({ brand, size = 16, className, title }: { brand: Brand; size?: number; className?: string; title?: string }) {
  const b = BRANDS[brand];
  return (
    <svg
      viewBox={b.viewBox}
      width={size}
      height={size}
      fill="currentColor"
      fillRule={'fillRule' in b ? (b.fillRule as 'evenodd') : undefined}
      className={cx('shrink-0', className)}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      // Static, bundled SVG markup (brand-data.ts), never user input.
      dangerouslySetInnerHTML={{ __html: b.svg }}
    />
  );
}

/** A logo on the same neutral tile as the other section icons. */
export function BrandTile({ brand, size = 'md' }: { brand: Brand; size?: 'sm' | 'md' | 'lg' }) {
  const box = { sm: 'size-7 rounded-lg', md: 'size-8 rounded-[10px]', lg: 'size-10 rounded-xl' }[size];
  const logo = { sm: 15, md: 17, lg: 21 }[size];
  return (
    <span aria-hidden className={cx('grid shrink-0 place-items-center bg-surface text-fg shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)]', box)}>
      <BrandLogo brand={brand} size={logo} />
    </span>
  );
}

/** The company behind a Copilot model, from its id or name. */
export function providerOf(model: { id?: string; name?: string; vendor?: string } | string): Brand | undefined {
  const s = (typeof model === 'string' ? model : `${model.vendor ?? ''} ${model.id ?? ''} ${model.name ?? ''}`).toLowerCase();
  if (/claude|anthropic/.test(s)) return 'claude';
  if (/gemini|google/.test(s)) return 'gemini';
  if (/microsoft|\bmai\b|\bmai-|\bphi-?\d/.test(s)) return 'microsoft';
  if (/\bgpt|openai|\bo[1-9]\b|o[1-9]-|codex/.test(s)) return 'openai';
  if (/grok|xai/.test(s)) return 'grok';
  if (/mistral|codestral|devstral/.test(s)) return 'mistral';
  if (/llama|meta/.test(s)) return 'meta';
  return undefined;
}

/** The logo for a repository host. */
export const hostBrand = (kind: 'codecommit' | 'github'): Brand => (kind === 'github' ? 'github' : 'aws');

/* ------------------------------------------------------------------ languages and frameworks */

const TECH_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  'node.js': 'node',
  nodejs: 'node',
  'next.js': 'nextjs',
  next: 'nextjs',
  'vue.js': 'vue',
  vuejs: 'vue',
  golang: 'go',
  'c#': 'csharp',
  '.net': 'dotnet',
  'asp.net': 'dotnet',
  'asp.net core': 'dotnet',
  'spring boot': 'springboot',
  'ruby on rails': 'rails',
  tailwindcss: 'tailwind',
  'tailwind css': 'tailwind',
  'nuxt.js': 'nuxt',
  'react native': 'reactnative',
  'express.js': 'express',
  expressjs: 'express',
  'nest.js': 'nestjs',
  nest: 'nestjs',
  sveltekit: 'svelte',
  'solid.js': 'solid',
  solidjs: 'solid',
  html5: 'html',
  css3: 'css',
  scss: 'sass',
};

/** The logo key for a language or framework name, if Tandem has its logo. */
export function techKey(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  if (TECH[n]) return n;
  if (TECH_ALIASES[n]) return TECH_ALIASES[n];
  const compact = n.replace(/[\s.-]/g, '');
  return TECH[compact] ? compact : undefined;
}

export function TechLogo({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  const key = techKey(name);
  const t = key ? TECH[key] : undefined;
  if (!t) return null;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className={cx('shrink-0', className)}>
      <path d={t.path} fill={t.color} />
    </svg>
  );
}

/** "TypeScript · Fastify + React" as logos with names; unknown names keep a plain dot. */
export function TechStack({ language, framework, className }: { language?: string | undefined; framework?: string | undefined; className?: string }) {
  const parts = [language, ...(framework ?? '').split(/\s*(?:\+|,|\/|&|\band\b)\s*/i)].map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  if (!unique.length) return <span className={className}>Unknown stack</span>;
  return (
    <span className={cx('inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1', className)}>
      {unique.map((p) => (
        <span key={p} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {techKey(p) ? <TechLogo name={p} size={13} /> : <span aria-hidden className="size-2 rounded-full bg-faint/60" />}
          {p}
        </span>
      ))}
    </span>
  );
}
