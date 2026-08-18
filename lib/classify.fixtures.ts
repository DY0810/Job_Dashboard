/**
 * HAND-LABELED FIXTURE SET.
 *
 * Every `expected` here is what the classifier SHOULD produce, written by hand from the
 * posting text. None of it is a recording of what a model actually said: asserting a model's
 * own output makes the suite flaky by construction and freezes its mistakes into the gate.
 *
 * The postings are synthetic but written in the shapes real ATS bodies arrive in. Company
 * names are invented; the vendor names inside the voice-AI bodies (Deepgram, Twilio, …) are
 * there because they are the technology the role actually uses, which is the signal
 * `lib/voice.ts` scores.
 *
 * Two consumers:
 *   - `classify.test.ts` — a stub client answers with `expected`, so the tests assert
 *     PIPELINE behavior (drop, badge, cache, cap), never model quality.
 *   - `scripts/enrich-smoke.ts` — a live Haiku run diffed against `expected` on
 *     `GRADED_FIELDS`. Free-text fields are illustrative and are not graded.
 */

import type { Classification } from './classify';

export interface ClassifyFixture {
  id: number;
  title: string;
  company: string;
  description: string;
  /** Hand-authored expectation. */
  expected: Classification;
  /** Hand-authored: is this a voice-AI role, judged on the body alone? */
  voice: boolean;
}

/** The fields a live model can be graded on deterministically. */
export const GRADED_FIELDS = [
  'track',
  'seniority',
  'employment_type',
  'internship_season',
  'paid',
  'work_mode',
  'pay_rate',
  'expected_grad',
] as const;

const BASE: Classification = {
  track: 'engineering',
  seniority: 'entry',
  employment_type: null,
  internship_season: null,
  paid: null,
  work_mode: null,
  location: null,
  pay_rate: null,
  expected_grad: null,
  summary: null,
  responsibilities: [],
  skills: [],
  education: [],
  badges: [],
};

function label(overrides: Partial<Classification>): Classification {
  return { ...BASE, ...overrides };
}

/**
 * 20 postings covering entry / junior / mid seniority, all four internship seasons, unpaid
 * design internships, three voice-AI engineering roles whose titles say nothing about voice,
 * the adversarial voice negatives, a marketing-copy-stuffed posting, and two `other` tracks
 * that must be dropped rather than stored.
 */
export const POSTING_FIXTURES: readonly ClassifyFixture[] = [
  {
    id: 1,
    title: 'Software Engineering Intern - Summer 2026',
    company: 'Northwind Labs',
    description: `Join our platform team for a 12-week summer internship. You will ship production code against our billing service, write tests, and present your project at the end of the program. Interns are paid $45/hour and are eligible for housing support. We are looking for students graduating in 2027 who have taken a data structures course and are comfortable in Python or Go.`,
    expected: label({
      track: 'engineering',
      seniority: 'entry',
      employment_type: 'internship',
      internship_season: 'summer',
      paid: true,
      work_mode: null,
      pay_rate: { min: 45, max: null, period: 'hour' },
      expected_grad: '2027',
      summary: 'Builds and tests production features on the billing service during a 12-week platform internship.',
      badges: ['internship'],
    }),
    voice: false,
  },
  {
    id: 2,
    title: 'Product Design Intern - Fall 2026',
    company: 'Harborline',
    description: `Our fall design internship runs September through December. You will work alongside two product designers on onboarding flows, run usability sessions, and contribute components to our design system. This is an unpaid internship offered for course credit only; we will work with your university to arrange credit. Portfolio required with the application.`,
    expected: label({
      track: 'design',
      seniority: 'entry',
      employment_type: 'internship',
      internship_season: 'fall',
      paid: false,
      badges: ['internship', 'portfolio-required'],
    }),
    voice: false,
  },
  {
    id: 3,
    title: 'Design Co-op - Winter Term',
    company: 'Grayfield Studio',
    description: `A winter co-op term for design students. You will support the brand team on illustration, packaging, and print layouts, and sit in on client reviews. The co-op is unpaid; we provide a transit pass and lunch on studio days. Please send a portfolio with three projects you can talk about.`,
    expected: label({
      track: 'design',
      seniority: 'entry',
      employment_type: 'internship',
      internship_season: 'winter',
      paid: false,
      badges: ['internship', 'portfolio-required'],
    }),
    voice: false,
  },
  {
    id: 4,
    title: 'Frontend Engineering Intern, Spring 2026',
    company: 'Ostrea Systems',
    description: `Spring internship on our web team, fully remote. You will build React components, fix accessibility bugs found in our last audit, and pair with an engineer on the checkout rewrite. The rate is $38/hour. Open to students who will still be enrolled after the term ends.`,
    expected: label({
      track: 'engineering',
      seniority: 'entry',
      employment_type: 'internship',
      internship_season: 'spring',
      paid: true,
      work_mode: 'remote',
      pay_rate: { min: 38, max: null, period: 'hour' },
      summary: 'Builds React components and fixes accessibility bugs on the web checkout flow.',
      badges: ['internship'],
    }),
    voice: false,
  },
  {
    id: 5,
    title: 'New Grad Software Engineer',
    company: 'Corvid Health',
    description: `Our new grad program places engineers on a product team for their first year with a dedicated mentor. You will own small services end to end, from schema to dashboard. Base salary $120,000 to $150,000 per year. Hybrid, three days a week in our New York office. Open to candidates graduating this academic year with a degree in computer science or equivalent experience.`,
    expected: label({
      track: 'engineering',
      seniority: 'entry',
      employment_type: 'full-time',
      paid: true,
      work_mode: 'hybrid',
      pay_rate: { min: 120000, max: 150000, period: 'year' },
      summary: 'Owns small backend services end to end on a product team during a mentored first year.',
      badges: ['new-grad'],
    }),
    voice: false,
  },
  {
    id: 6,
    title: 'Junior Product Designer',
    company: 'Talltree',
    description: `We are hiring a junior product designer to work on our customer dashboard. You will turn research findings into flows and screens, keep our Figma libraries tidy, and present work in weekly critique. Salary $85,000 to $105,000. Onsite in Austin. One to two years of design experience, internships count.`,
    expected: label({
      track: 'design',
      seniority: 'junior',
      employment_type: 'full-time',
      paid: true,
      work_mode: 'onsite',
      pay_rate: { min: 85000, max: 105000, period: 'year' },
    }),
    voice: false,
  },
  {
    id: 7,
    title: 'Backend Engineer, Payments',
    company: 'Quillon',
    description: `You will work on the services that move money: idempotent transfer APIs, reconciliation jobs, and the ledger. We expect around three years of backend experience and comfort with Postgres under load. Remote within the US. $140,000 to $165,000 plus equity.`,
    expected: label({
      track: 'engineering',
      seniority: 'mid',
      employment_type: 'full-time',
      paid: true,
      work_mode: 'remote',
      pay_rate: { min: 140000, max: 165000, period: 'year' },
      summary: 'Builds transfer APIs, reconciliation jobs and ledger services for a payments platform.',
    }),
    voice: false,
  },
  {
    id: 8,
    title: 'Associate UX Designer',
    company: 'Bellweather Co',
    description: `An associate role on our platform design team. You will run moderated sessions with a researcher, synthesize findings into journey maps, and produce wireframes for the accounts area. Suited to someone one or two years into their career. Hybrid in Chicago, two days in office. Portfolio required.`,
    expected: label({
      track: 'design',
      seniority: 'junior',
      employment_type: 'full-time',
      work_mode: 'hybrid',
      badges: ['portfolio-required'],
    }),
    voice: false,
  },
  {
    id: 9,
    title: 'Member of Technical Staff',
    company: 'Ansel AI',
    description: `You will work on the real-time agent stack. Concretely: reducing time to first audio, tuning endpointing so the agent does not talk over people, and getting barge-in to feel natural on bad mobile connections. We run our own turn detection model. Experience with WebRTC or streaming audio helps but is not required; we care more about how you debug latency. Around three years of engineering experience. Remote, US time zones. $150,000 to $180,000.`,
    expected: label({
      track: 'engineering',
      seniority: 'mid',
      employment_type: 'full-time',
      paid: true,
      work_mode: 'remote',
      pay_rate: { min: 150000, max: 180000, period: 'year' },
      summary: 'Works on real-time voice agent latency, endpointing and barge-in behavior.',
    }),
    voice: true,
  },
  {
    id: 10,
    title: 'Forward Deployed Engineer',
    company: 'Relayworks',
    description: `You will sit with customers and get their deployments live. That means wiring up telephony through Twilio, debugging SIP trunk configuration, and holding a latency budget across ASR, the model, and TTS so calls stay under a second. Expect to write a lot of glue code and a fair amount of customer email. Two to four years of experience. Hybrid, Denver.`,
    expected: label({
      track: 'engineering',
      seniority: 'mid',
      employment_type: 'full-time',
      work_mode: 'hybrid',
      summary: 'Deploys customer voice integrations across telephony, ASR and TTS while holding a latency budget.',
    }),
    voice: true,
  },
  {
    id: 11,
    title: 'Applied AI Engineer',
    company: 'Cadence Point',
    description: `Early career role on our applied team. You will evaluate speech-to-speech models, wire Deepgram and Cartesia into our pipeline, and build the harness we use to score conversations. Some diarization work on recorded calls. New grads welcome; we care about evaluation rigor more than years served. Remote. $115,000 to $135,000.`,
    expected: label({
      track: 'engineering',
      seniority: 'junior',
      employment_type: 'full-time',
      paid: true,
      work_mode: 'remote',
      pay_rate: { min: 115000, max: 135000, period: 'year' },
      summary: 'Evaluates speech models and builds the scoring harness for a conversational AI pipeline.',
      badges: ['new-grad'],
    }),
    voice: true,
  },
  {
    id: 12,
    title: 'Associate UX Researcher, Voice of the Customer',
    company: 'Marlow Retail',
    description: `Join the insights team behind our voice of the customer program. You will run interviews with shoppers, code open-ended survey responses, and write up findings for merchandising partners. One to two years of research experience or a related graduate program. Hybrid, Seattle.`,
    expected: label({
      track: 'design',
      seniority: 'junior',
      employment_type: 'full-time',
      work_mode: 'hybrid',
    }),
    voice: false,
  },
  {
    id: 13,
    title: 'Brand Designer',
    company: 'Fernbank',
    description: `We are looking for a junior brand designer to help our brand voice show up consistently across campaigns, packaging, and the website. You will produce layouts, adapt assets for social, and keep our type and color usage honest. Portfolio required. Onsite in Portland, $70,000 to $88,000.`,
    expected: label({
      track: 'design',
      seniority: 'junior',
      employment_type: 'full-time',
      paid: true,
      work_mode: 'onsite',
      pay_rate: { min: 70000, max: 88000, period: 'year' },
      badges: ['portfolio-required'],
    }),
    voice: false,
  },
  {
    id: 14,
    title: 'Voice and Tone Content Designer',
    company: 'Sundial Software',
    description: `You will own the words in our product: empty states, error messages, onboarding, and the style guide that keeps them consistent. Expect to work in Figma next to designers and in pull requests next to engineers. One to three years writing for software. Remote within the EU.`,
    expected: label({
      track: 'design',
      seniority: 'junior',
      employment_type: 'full-time',
      work_mode: 'remote',
    }),
    voice: false,
  },
  {
    id: 15,
    title: 'Junior Frontend Engineer',
    company: 'Pinnacle Growth',
    description: `Are you a rockstar developer who thrives in a fast-paced environment? We are a world-class team of unicorns who wear many hats and work hard, play hard. We are like a family here. You will make an impact from day one! Ninja-level JavaScript skills required. The actual work: maintaining our marketing site in Next.js and building internal admin screens. One to two years of experience.`,
    expected: label({
      track: 'engineering',
      seniority: 'junior',
      employment_type: 'full-time',
      summary: 'Maintains a Next.js marketing site and builds internal admin screens.',
      responsibilities: ['Maintain the marketing site in Next.js', 'Build internal admin screens'],
      skills: ['JavaScript', 'Next.js'],
    }),
    voice: false,
  },
  {
    id: 16,
    // Titled the way the prefilter cannot see it, so the MODEL's track drop is what runs.
    // "Associate Product Manager" is the other common spelling and the prefilter catches
    // that one on `manager` — same outcome, cheaper. Both are asserted in classify.test.ts.
    title: 'Product Management Associate, New Grad Program',
    company: 'Kestrel Data',
    description: `Our APM program takes new grads and puts them on a product team with a mentor. You will write specs, run standups, and own a metric. Rotations across three teams in the first year. $130,000 base.`,
    expected: label({ track: 'other', seniority: 'entry', employment_type: 'full-time', paid: true }),
    voice: false,
  },
  {
    id: 17,
    title: 'Marketing Associate',
    company: 'Halyard',
    description: `Support our campaigns team on email, paid social, and event logistics. You will pull performance numbers, brief the design team on assets, and keep the content calendar. One to two years in marketing or a communications degree.`,
    expected: label({ track: 'other', seniority: 'junior', employment_type: 'full-time' }),
    voice: false,
  },
  {
    id: 18,
    title: 'Junior Machine Learning Engineer',
    company: 'Verdant Grid',
    description: `You will work on demand forecasting: feature pipelines, model retraining, and the batch jobs that publish predictions to our operations tooling. Comfortable with Python and pandas, some exposure to PyTorch. One to two years of experience or a relevant masters. Remote, $125,000 to $145,000.`,
    expected: label({
      track: 'engineering',
      seniority: 'junior',
      employment_type: 'full-time',
      paid: true,
      work_mode: 'remote',
      pay_rate: { min: 125000, max: 145000, period: 'year' },
      summary: 'Builds feature pipelines and retraining jobs for demand forecasting models.',
    }),
    voice: false,
  },
  {
    id: 19,
    title: 'Graduate Software Engineer (Entry Level)',
    company: 'Ashgrove Systems',
    description: `A graduate scheme for engineers in their first role. Six months of structured training, then placement on a team building our logistics platform. We sponsor visas for graduates of accredited programs. Fully remote across the UK and Ireland.`,
    expected: label({
      track: 'engineering',
      seniority: 'entry',
      employment_type: 'full-time',
      paid: null,
      work_mode: 'remote',
      summary: 'Trains then joins a team building a logistics platform as a graduate engineer.',
      badges: ['new-grad', 'visa-sponsorship'],
    }),
    voice: false,
  },
  {
    id: 20,
    title: 'Design Systems Intern - Spring 2027',
    company: 'Ironwood Interactive',
    description: `Spring internship with our design systems group. You will audit component usage across three products, document patterns, and help ship the token migration. Paid at $30/hour for a 16-week term. Open to students graduating in December 2027 or later.`,
    expected: label({
      track: 'design',
      seniority: 'entry',
      employment_type: 'internship',
      internship_season: 'spring',
      paid: true,
      pay_rate: { min: 30, max: null, period: 'hour' },
      expected_grad: 'December 2027',
      badges: ['internship'],
    }),
    voice: false,
  },
];

/**
 * Senior / staff / principal / lead / director / manager / 5+-years postings. Hard-drop
 * recall on this set is 100% — the regex prefilter alone must catch every one, so none of
 * them ever becomes an API call.
 */
export const SENIOR_FIXTURES: readonly Omit<ClassifyFixture, 'expected' | 'voice'>[] = [
  {
    id: 101,
    title: 'Senior Product Designer',
    company: 'Northwind Labs',
    description: 'Own the end-to-end design of our reporting suite and mentor two designers.',
  },
  {
    id: 102,
    title: 'Staff Software Engineer, Platform',
    company: 'Corvid Health',
    description: 'Set technical direction for the platform group and land cross-team migrations.',
  },
  {
    id: 103,
    title: 'Principal Engineer',
    company: 'Quillon',
    description: 'Define architecture across payments and represent engineering in planning.',
  },
  {
    id: 104,
    title: 'Lead UX Designer',
    company: 'Bellweather Co',
    description: 'Guide a squad of designers through discovery and delivery on the accounts area.',
  },
  {
    id: 105,
    title: 'Engineering Manager, Growth',
    company: 'Talltree',
    description: 'Manage a team of six engineers, run hiring, and own the growth roadmap.',
  },
  {
    id: 106,
    title: 'Director of Design',
    company: 'Harborline',
    description: 'Own design across the company and build out the practice.',
  },
  {
    id: 107,
    title: 'Sr. Frontend Engineer',
    company: 'Ostrea Systems',
    description: 'Drive the frontend architecture of our customer-facing applications.',
  },
  {
    id: 108,
    title: 'Software Engineer II',
    company: 'Verdant Grid',
    description:
      'You have 5+ years of experience building distributed systems and can take an ambiguous problem to a design doc.',
  },
  {
    id: 109,
    title: 'Backend Engineer',
    company: 'Ashgrove Systems',
    description:
      'We are looking for someone with 7 years of professional experience in Java or Kotlin services.',
  },
  {
    id: 110,
    title: 'Design Manager',
    company: 'Fernbank',
    description: 'Lead the brand design team and partner with marketing leadership.',
  },
  {
    id: 111,
    title: 'Senior Staff Machine Learning Engineer',
    company: 'Cadence Point',
    description: 'Own our model evaluation strategy and mentor the applied team.',
  },
  {
    id: 112,
    title: 'Technical Lead, Payments',
    company: 'Marlow Retail',
    description: 'Technical leadership for the payments squad, including on-call and roadmap.',
  },
  {
    id: 113,
    title: 'Product Design Lead',
    company: 'Sundial Software',
    description: 'Set the design direction for our core product surface.',
  },
  {
    id: 114,
    title: 'Full Stack Engineer',
    company: 'Halyard',
    description:
      'The ideal candidate has 10+ years building web applications and has shipped at scale.',
  },
  {
    id: 115,
    title: 'Engineering Director, Infrastructure',
    company: 'Kestrel Data',
    description: 'Own infrastructure strategy and manage three teams.',
  },
  {
    id: 116,
    title: 'UX Designer',
    company: 'Grayfield Studio',
    description:
      'You have 6+ years designing consumer products and a portfolio of shipped work to show for it.',
  },
];

/**
 * ONE posting, in the three shapes the Tier-1 ATS families return it in, plus the same
 * Greenhouse body after trivial whitespace and re-escaping churn. All four must collapse to a
 * single `enrichment_cache` row (finding B) — raw-body hashing misses on every one of them.
 */
export const ATS_SHAPES: readonly { source: string; title: string; company: string; description: string }[] = [
  {
    source: 'greenhouse',
    title: 'Product Designer',
    company: 'Harborline',
    description:
      '&lt;p&gt;We are looking for a Product Designer.&lt;/p&gt;&lt;h3&gt;Responsibilities&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Ship design systems&lt;/li&gt;&lt;/ul&gt;',
  },
  {
    source: 'lever',
    title: 'Product Designer',
    company: 'Harborline',
    // descriptionPlain, then the `lists[]` array flattened by the connector.
    description: 'We are looking for a Product Designer.\n\nResponsibilities\n\n- Ship design systems',
  },
  {
    source: 'ashby',
    title: 'Product Designer',
    company: 'Harborline',
    description: 'We are looking for a Product Designer.\n\n### Responsibilities\n\n- Ship design systems',
  },
  {
    source: 'greenhouse-reformatted',
    title: 'Product Designer',
    company: 'Harborline',
    description:
      '&lt;p&gt;We are looking for a Product Designer.&lt;/p&gt;\n\n  &lt;h3&gt;Responsibilities&lt;/h3&gt;\n  &lt;ul&gt;\n    &lt;li&gt;Ship design systems&lt;/li&gt;\n  &lt;/ul&gt;\n',
  },
];
