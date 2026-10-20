import { describe, expect, it } from 'vitest';
import { leverSelectOptions } from './form-options.ts';

const html = String.raw`<input type="hidden" name="cards[a][baseTemplate]" value="{&quot;fields&quot;: [{&quot;type&quot;: &quot;dropdown&quot;, &quot;text&quot;: &quot;Which university are you currently attending? Please select \&quot;Other\&quot;.&quot;, &quot;options&quot;: [{&quot;text&quot;: &quot;Arizona State University&quot;}, {&quot;text&quot;: &quot;Texas A&amp;M University&quot;}]}]}">
<input type="hidden" name="cards[a][baseTemplate]" value="{&quot;fields&quot;: [{&quot;type&quot;: &quot;text&quot;, &quot;text&quot;: &quot;High School Name&quot;}, {&quot;type&quot;: &quot;dropdown&quot;, &quot;text&quot;: &quot;Year&quot;, &quot;options&quot;: [{&quot;text&quot;: &quot;2027&quot;}]}]}">`;

describe('leverSelectOptions', () => {
  it('returns the choices of the dropdown labeled with the question', () => {
    expect(leverSelectOptions(html, 'Which university are you currently attending? Please select "Other".\n\nMore text'))
      .toEqual(['Arizona State University', 'Texas A&M University']);
    expect(leverSelectOptions(html, 'Year')).toEqual(['2027']);
  });
  it('returns nothing for a question with no dropdown', () => {
    expect(leverSelectOptions(html, 'High School Name')).toEqual([]);
  });
});
