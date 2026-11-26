const KIND_NAME: Record<string, string> = {
  patient: 'patient',
  relative: 'relative',
  clinician: 'clinician',
  person: 'person',
  organization: 'organization',
  address: 'place',
  date: 'date',
  dob: 'birth date',
  phone: 'phone',
  email: 'email',
  record: 'record number',
  url: 'link',
}

export function kindName(kind: string): string {
  return KIND_NAME[kind] ?? kind
}
