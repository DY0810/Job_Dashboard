import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DRAWER = readFileSync('app/drawer.tsx', 'utf8');
const PANEL = readFileSync('app/outreach-panel.tsx', 'utf8');

describe('embedded-browser outreach forms', () => {
  it('does not depend on native prompts in either outreach flow', () => {
    expect(DRAWER).not.toMatch(/\bwindow\.prompt\s*\(/);
    expect(PANEL).not.toMatch(/\bwindow\.prompt\s*\(/);
  });

  it('keeps sender setup local, required, and explicitly saveable or cancellable', () => {
    expect(DRAWER).toContain('aria-label="Sender profile"');
    expect(DRAWER).toContain('type="email"');
    expect(DRAWER).toContain('required');
    expect(DRAWER).toContain('>save</button>');
    expect(DRAWER).toContain('>cancel</button>');
    expect(DRAWER).not.toContain('altKey');
  });

  it('requires an explicit token save before a later send action', () => {
    const tokenForm = PANEL.split('{tokenForm ? (')[1]?.split(') : null}')[0] ?? '';
    expect(tokenForm).toContain('aria-label="Send token"');
    expect(tokenForm).toContain('type="password"');
    expect(tokenForm).toContain('>save token</button>');
    expect(tokenForm).toContain('>cancel</button>');
    expect(tokenForm).not.toContain('sendQueue');
    expect(tokenForm).toContain('disabled={sending}');
  });
});
