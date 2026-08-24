import { describe, expect, it } from 'vitest';

import { matchAtsSignatures, robotsPathAllowed } from '../ats-probe.js';

describe('matchAtsSignatures — reading the ATS + token off a careers page', () => {
  it('pulls the real token out of each ATS embed shape', () => {
    const html = `
      <a href="https://jobs.ashbyhq.com/mazedesign">Careers</a>
      <script src="https://boards.greenhouse.io/embed/job_board?for=headspacehq"></script>
      <iframe src="https://jobs.lever.co/activetheory"></iframe>
    `;
    const got = new Set(matchAtsSignatures(html).map((c) => `${c.ats}:${c.token}`));
    expect(got.has('ashby:mazedesign')).toBe(true);
    expect(got.has('greenhouse:headspacehq')).toBe(true);
    expect(got.has('lever:activetheory')).toBe(true);
  });

  it('captures the FULL slug, never a prefix — the mislabel risk', () => {
    // `frontcareers`, not `front`: a truncated token could false-confirm against another
    // company's real board, so the capture must run to the path boundary.
    const [hit] = matchAtsSignatures('<a href="https://jobs.ashbyhq.com/frontcareers/apply">x</a>');
    expect(hit).toEqual({ ats: 'ashby', token: 'frontcareers' });
  });

  it('drops the platform\'s own non-company words', () => {
    // `embed` is in the greenhouse embed path, not a board token.
    expect(matchAtsSignatures('boards.greenhouse.io/embed/job_board')).toEqual([]);
  });

  it('returns nothing for a page that names no ATS', () => {
    expect(matchAtsSignatures('<html><body>We are hiring! email jobs@acme.com</body></html>')).toEqual([]);
  });
});

describe('robotsPathAllowed — the /*? wildcard that kept jobspresso dead', () => {
  const robots = 'User-agent: *\nDisallow: /*?\nDisallow: /wp-admin/\nCrawl-delay: 3';

  it('does NOT block a plain path just because a query-string rule exists', () => {
    expect(robotsPathAllowed(robots, '/careers')).toBe(true); // /*? is query-only
    expect(robotsPathAllowed(robots, '/jobs')).toBe(true);
  });

  it('still blocks an explicitly disallowed prefix', () => {
    expect(robotsPathAllowed(robots, '/wp-admin/options.php')).toBe(false);
  });

  it('honours a bare Disallow: / and an empty file', () => {
    expect(robotsPathAllowed('User-agent: *\nDisallow: /', '/careers')).toBe(false);
    expect(robotsPathAllowed('', '/careers')).toBe(true);
  });

  it('ignores rules under a different user-agent block', () => {
    const other = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin';
    expect(robotsPathAllowed(other, '/careers')).toBe(true);
    expect(robotsPathAllowed(other, '/admin')).toBe(false);
  });
});
