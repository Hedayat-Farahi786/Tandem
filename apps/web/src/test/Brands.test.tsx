import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BrandLogo, hostBrand, providerOf } from '../ui/brands';

describe('brand logos', () => {
  it('maps Copilot models to the company that makes them', () => {
    expect(providerOf({ id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', vendor: 'Anthropic' })).toBe('claude');
    expect(providerOf({ id: 'gpt-6-luna', name: 'GPT-6 Luna', vendor: 'OpenAI' })).toBe('openai');
    expect(providerOf({ id: 'o4-mini', name: 'o4-mini' })).toBe('openai');
    expect(providerOf({ id: 'gemini-3-pro', name: 'Gemini 3 Pro', vendor: 'Google' })).toBe('gemini');
    expect(providerOf('grok-code-fast')).toBe('grok');
    expect(providerOf({ id: 'mai-1', name: 'MAI 1', vendor: 'Microsoft' })).toBe('microsoft');
    expect(providerOf('mai-ds-r1')).toBe('microsoft');
    expect(providerOf({ id: 'gpt-6-luna', name: 'GPT-6 Luna', vendor: 'OpenAI' })).not.toBe('microsoft');
    expect(providerOf({ id: 'scripted-swift', name: 'Scripted Swift' })).toBeUndefined();
    expect([hostBrand('github'), hostBrand('codecommit')]).toEqual(['github', 'aws']);
  });

  it('draws the bundled SVG, hidden from screen readers unless it has a title', () => {
    const { container } = render(
      <>
        <BrandLogo brand="jira" />
        <BrandLogo brand="github" title="GitHub" />
      </>,
    );
    const [jira, github] = [...container.querySelectorAll('svg')];
    expect(jira!.getAttribute('aria-hidden')).toBe('true');
    expect(jira!.querySelector('path')?.getAttribute('fill')).toBe('#0052CC');
    expect(github!.getAttribute('role')).toBe('img');
    expect(github!.getAttribute('aria-label')).toBe('GitHub');
    // No external references: everything is inline.
    expect(container.innerHTML).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});

describe('technology logos', () => {
  it('shows a logo for each known language and framework, and a dot for the rest', async () => {
    const { TechStack, techKey } = await import('../ui/brands');
    expect(['TypeScript', 'Node.js', 'Next.js', 'golang', 'C#', 'Spring Boot', 'Tailwind CSS'].map(techKey)).toEqual(['typescript', 'node', 'nextjs', 'go', 'csharp', 'springboot', 'tailwind']);
    expect(techKey('Cobol')).toBeUndefined();
    const { container } = render(<TechStack language="TypeScript" framework="Fastify + React, Cobol" />);
    expect(container.textContent).toBe('TypeScriptFastifyReactCobol');
    expect(container.querySelectorAll('svg')).toHaveLength(3);
    expect(render(<TechStack />).container.textContent).toBe('Unknown stack');
  });
});
