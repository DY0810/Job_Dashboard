import { createFormAdapter } from './form-adapter.ts';

export const jobvite = createFormAdapter({
  id: 'jobvite',
  fields: [
    { key: 'first_name', label: 'First name', kind: 'text', required: true },
    { key: 'last_name', label: 'Last name', kind: 'text', required: true },
    { key: 'email', label: 'Email', kind: 'email', required: true },
    { key: 'start_date', label: 'Available start date', kind: 'date', required: true },
    { key: 'work_authorization', label: 'Work authorization', kind: 'select', required: true, options: ['Yes', 'No'] },
    { key: 'resume', label: 'Resume', kind: 'file', required: true },
  ],
});
