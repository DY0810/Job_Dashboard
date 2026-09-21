import { createFormAdapter } from './form-adapter.ts';

export const workday = createFormAdapter({
  id: 'workday',
  fields: [
    { key: 'first_name', label: 'First name', kind: 'text', required: true },
    { key: 'last_name', label: 'Last name', kind: 'text', required: true },
    { key: 'email', label: 'Email', kind: 'email', required: true },
    { key: 'graduation_month', label: 'Graduation month', kind: 'select', required: true, options: ['May', 'December'] },
    { key: 'graduation_year', label: 'Graduation year', kind: 'select', required: true, options: ['2027', '2028'] },
    { key: 'work_authorization', label: 'Work authorization', kind: 'select', required: true, options: ['Yes', 'No'] },
    { key: 'resume', label: 'Resume', kind: 'file', required: true },
  ],
});
