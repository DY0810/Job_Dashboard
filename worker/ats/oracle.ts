import { createFormAdapter } from './form-adapter.ts';

export const oracle = createFormAdapter({
  id: 'oracle',
  fields: [
    { key: 'first_name', label: 'First name', kind: 'text', required: true },
    { key: 'last_name', label: 'Last name', kind: 'text', required: true },
    { key: 'email', label: 'Email', kind: 'email', required: true },
    { key: 'degree_status', label: 'Degree status', kind: 'select', required: true, options: ['In progress', 'Completed'] },
    { key: 'previous_employer', label: 'Previous employer', kind: 'text', required: true },
    { key: 'work_authorization', label: 'Work authorization', kind: 'select', required: true, options: ['Yes', 'No'] },
    { key: 'resume', label: 'Resume', kind: 'file', required: true },
  ],
});
