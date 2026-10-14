import { describe, expect, it } from 'vitest';
import { jobLinkFor } from './job-link';

/** Just enough of Element for `closest`/`querySelector`: a node knows its tag and its ancestors. */
function node(tag: string, parent: FakeNode | null = null, attrs: string[] = []): FakeNode {
  const self: FakeNode = {
    tag, parent, attrs, children: [],
    closest(selector) {
      for (let at: FakeNode | null = self; at; at = at.parent) if (matches(at, selector)) return at;
      return null;
    },
    querySelector(selector) {
      const walk = (n: FakeNode): FakeNode | null => n.children.find((c) => matches(c, selector)) ?? n.children.map(walk).find(Boolean) ?? null;
      return walk(self);
    },
  };
  parent?.children.push(self);
  return self;
}
type FakeNode = { tag: string; parent: FakeNode | null; attrs: string[]; children: FakeNode[];
  closest(selector: string): FakeNode | null; querySelector(selector: string): FakeNode | null };
const matches = (n: FakeNode, selector: string) => selector.split(',').map((s) => s.trim()).some((s) =>
  s === 'a[data-job]' ? n.tag === 'a' && n.attrs.includes('data-job') : s === n.tag);
const asElement = (n: FakeNode) => n as unknown as Element;

const row = () => {
  const tr = node('tr');
  const title = node('span', node('td', tr));
  const company = node('a', node('td', tr), ['data-job']);
  const apply = node('a', node('td', tr));
  const checkbox = node('input', node('td', tr));
  const badge = node('button', node('td', tr));
  return { tr, title, company, apply, checkbox, badge };
};

describe('jobLinkFor', () => {
  it('opens from the company link itself', () => {
    const r = row();
    expect(jobLinkFor(asElement(r.company))).toBe(r.company);
  });
  it('opens from the title, or anywhere else in the row', () => {
    const r = row();
    expect(jobLinkFor(asElement(r.title))).toBe(r.company);
    expect(jobLinkFor(asElement(r.tr))).toBe(r.company);
  });
  it("leaves the row's own controls alone", () => {
    const r = row();
    expect(jobLinkFor(asElement(r.apply))).toBeNull();
    expect(jobLinkFor(asElement(r.checkbox))).toBeNull();
    expect(jobLinkFor(asElement(r.badge))).toBeNull();
  });
  it('ignores clicks outside a row', () => {
    expect(jobLinkFor(asElement(node('div')))).toBeNull();
    expect(jobLinkFor(null)).toBeNull();
  });
});
