import { BRANDS } from './brand-data';
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
  if (/\bgpt|openai|\bo[1-9]\b|o[1-9]-|codex/.test(s)) return 'openai';
  if (/grok|xai/.test(s)) return 'grok';
  if (/mistral|codestral|devstral/.test(s)) return 'mistral';
  if (/llama|meta/.test(s)) return 'meta';
  return undefined;
}

/** The logo for a repository host. */
export const hostBrand = (kind: 'codecommit' | 'github'): Brand => (kind === 'github' ? 'github' : 'aws');
