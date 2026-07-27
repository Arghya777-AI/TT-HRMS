/**
 * personal.api.ts — E-07 Tab 4: contacts, addresses, dependents/nominees,
 * qualifications and identity documents.
 *
 * All five satellites carry a `self_all` RLS policy scoped to
 * `app.current_employee_id()` (migration 009), so these are genuinely the
 * employee's own rows. `employee_identity_documents` is the exception worth
 * naming: migration 033 re-grants only `number_last4`, never `document_number`,
 * so a passport or licence number cannot be read here at all — the column is
 * not in the projection because it is not in the grant.
 */
import { z } from "zod";
import { dbDate, dbDateNullable, dbNumericNullable, dbTimestampNullable, dbUuid, eq, selectMany } from "@/shared/api/query";
import { insertOne } from "@/shared/api/write";

export const ADDRESSES_TABLE = "employee_addresses";
export const CONTACTS_TABLE = "employee_contacts";
export const DEPENDENTS_TABLE = "employee_dependents";
export const QUALIFICATIONS_TABLE = "employee_qualifications";
export const IDENTITY_DOCUMENTS_TABLE = "employee_identity_documents";

// -----------------------------------------------------------------------------
// 1. Addresses
// -----------------------------------------------------------------------------

export const addressKindSchema = z.enum([
  "permanent", "correspondence", "emergency", "previous",
]);
export type AddressKind = z.infer<typeof addressKindSchema>;

export const addressSchema = z.object({
  id: dbUuid,
  address_kind: addressKindSchema,
  line1: z.string(),
  line2: z.string().nullable(),
  landmark: z.string().nullable(),
  city: z.string(),
  district: z.string().nullable(),
  state: z.string(),
  pincode: z.string(),
  country: z.string(),
  is_current: z.boolean(),
  valid_from: dbDateNullable,
  valid_to: dbDateNullable,
});

export type Address = z.infer<typeof addressSchema>;

export async function fetchAddresses(
  employeeId: string,
  signal?: AbortSignal,
): Promise<Address[]> {
  return selectMany(ADDRESSES_TABLE, addressSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "is_current", ascending: false }, { column: "address_kind" }],
    limit: 25,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 2. Contacts (including emergency contacts)
// -----------------------------------------------------------------------------

export const contactKindSchema = z.enum([
  "mobile", "alternate_mobile", "residence", "office", "office_extension",
  "emergency", "whatsapp",
]);
export type ContactKind = z.infer<typeof contactKindSchema>;

export const contactSchema = z.object({
  id: dbUuid,
  contact_kind: contactKindSchema,
  value: z.string(),
  contact_name: z.string().nullable(),
  relationship: z.string().nullable(),
  is_primary: z.boolean(),
  is_verified: z.boolean(),
});

export type Contact = z.infer<typeof contactSchema>;

export async function fetchContacts(
  employeeId: string,
  signal?: AbortSignal,
): Promise<Contact[]> {
  return selectMany(CONTACTS_TABLE, contactSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "is_primary", ascending: false }, { column: "contact_kind" }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

const CONTACT_COLUMNS =
  "id, contact_kind, value, contact_name, relationship, is_primary, is_verified";

/**
 * Add an emergency contact on the caller's own record.
 *
 * `employee_contacts` carries `employee_contacts__self_all` (migration 009) and
 * is NOT in `audit.reason_required_tables`, so `insertOne` is the right helper
 * and no `X-Reason` is sent. Both DB CHECKs are the server's to enforce:
 * `ck_ec__value` wants 6–14 digits for an emergency number and
 * `ck_ec__emergency_fields` requires name + relationship — a violation returns
 * `23514`, which `QueryError` maps to `kind: "conflict"` with the DB's message.
 */
export async function addEmergencyContact(
  input: {
    readonly employeeId: string;
    readonly value: string;
    readonly contactName: string;
    readonly relationship: string;
    readonly isPrimary?: boolean;
  },
  signal?: AbortSignal,
): Promise<Contact> {
  return insertOne(
    CONTACTS_TABLE,
    contactSchema,
    {
      employee_id: input.employeeId,
      contact_kind: "emergency",
      value: input.value,
      contact_name: input.contactName,
      relationship: input.relationship,
      is_primary: input.isPrimary ?? true,
    },
    { columns: CONTACT_COLUMNS, ...(signal ? { signal } : {}) },
  );
}

/** Emergency contacts get their own card — never jammed into contacts (DR-48). */
export function emergencyContacts(rows: readonly Contact[]): Contact[] {
  return rows.filter((c) => c.contact_kind === "emergency");
}

export function nonEmergencyContacts(rows: readonly Contact[]): Contact[] {
  return rows.filter((c) => c.contact_kind !== "emergency");
}

// -----------------------------------------------------------------------------
// 3. Dependents & nominees
// -----------------------------------------------------------------------------

export const dependentSchema = z.object({
  id: dbUuid,
  full_name: z.string(),
  relationship: z.string(),
  date_of_birth: dbDateNullable,
  gender: z.enum(["male", "female", "transgender", "prefer_not_to_say"]).nullable(),
  is_nominee: z.boolean(),
  /** Percentage already on a 0–100 scale; the DB CHECK bounds it. */
  nominee_share_pct: dbNumericNullable,
  nominee_scheme: z.enum(["pf", "gratuity", "esi", "group_insurance"]).nullable(),
  is_dependent_for_insurance: z.boolean(),
  aadhaar_last4: z.string().nullable(),
});

export type Dependent = z.infer<typeof dependentSchema>;

export async function fetchDependents(
  employeeId: string,
  signal?: AbortSignal,
): Promise<Dependent[]> {
  return selectMany(DEPENDENTS_TABLE, dependentSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "is_nominee", ascending: false }, { column: "full_name" }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 4. Qualifications
// -----------------------------------------------------------------------------

export const qualificationSchema = z.object({
  id: dbUuid,
  qualification_kind: z.enum([
    "school", "diploma", "graduate", "post_graduate", "doctorate",
    "certification", "licence",
  ]),
  degree_or_course: z.string().nullable(),
  specialisation: z.string().nullable(),
  institution: z.string().nullable(),
  board_or_university: z.string().nullable(),
  mode: z.enum(["full_time", "part_time", "distance"]).nullable(),
  start_year: z.union([z.number().int(), z.string().transform(Number), z.null()]),
  end_year: z.union([z.number().int(), z.string().transform(Number), z.null()]),
  grade_or_percentage: z.string().nullable(),
  is_highest: z.boolean(),
  verified_at: dbTimestampNullable,
  licence_kind: z.string().nullable(),
  licence_expiry: dbDateNullable,
  document_id: z.string().uuid().nullable(),
});

export type Qualification = z.infer<typeof qualificationSchema>;

export async function fetchQualifications(
  employeeId: string,
  signal?: AbortSignal,
): Promise<Qualification[]> {
  return selectMany(QUALIFICATIONS_TABLE, qualificationSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "is_highest", ascending: false }, { column: "end_year", ascending: false }],
    limit: 50,
    ...(signal ? { signal } : {}),
  });
}

// -----------------------------------------------------------------------------
// 5. Identity documents (passport / visa / licence — last-4 only)
// -----------------------------------------------------------------------------

export const idDocumentKindSchema = z.enum([
  "aadhaar", "pan", "passport", "visa", "driving_licence", "voter_id",
  "ration_card", "other",
]);
export type IdDocumentKind = z.infer<typeof idDocumentKindSchema>;

/**
 * Note the absent `document_number`: migration 033's column grant stops at
 * `number_last4`. Asking for the full number would be a `42703` schema error,
 * which is the design working as intended.
 */
export const identityDocumentSchema = z.object({
  id: dbUuid,
  document_kind: idDocumentKindSchema,
  number_last4: z.string(),
  name_on_document: z.string().nullable(),
  issue_date: dbDateNullable,
  expiry_date: dbDateNullable,
  issuing_country: z.string(),
  issuing_authority: z.string().nullable(),
  place_of_issue: z.string().nullable(),
  visa_kind: z.enum(["employment", "business", "tourist"]).nullable(),
  visa_valid_from: dbDateNullable,
  visa_valid_to: dbDateNullable,
  is_verified: z.boolean(),
  is_current: z.boolean(),
});

export type IdentityDocument = z.infer<typeof identityDocumentSchema>;

const IDENTITY_DOCUMENT_COLUMNS =
  "id, document_kind, number_last4, name_on_document, issue_date, expiry_date, " +
  "issuing_country, issuing_authority, place_of_issue, visa_kind, visa_valid_from, " +
  "visa_valid_to, is_verified, is_current";

export async function fetchIdentityDocuments(
  employeeId: string,
  signal?: AbortSignal,
): Promise<IdentityDocument[]> {
  return selectMany(IDENTITY_DOCUMENTS_TABLE, identityDocumentSchema, {
    filters: [eq("employee_id", employeeId)],
    order: [{ column: "is_current", ascending: false }, { column: "document_kind" }],
    columns: IDENTITY_DOCUMENT_COLUMNS,
    limit: 25,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Passport and visa cards render only when they can apply (spec-employee Tab 4):
 * a non-Indian national, or an employee who already holds a passport row.
 */
export function shouldShowTravelDocuments(
  nationality: string,
  documents: readonly IdentityDocument[],
): boolean {
  const isIndian = nationality.trim().toLowerCase() === "india"
    || nationality.trim().toLowerCase() === "indian";
  return !isIndian || documents.some((d) => d.document_kind === "passport" || d.document_kind === "visa");
}

// -----------------------------------------------------------------------------
// 6. The whole Tab-4 bundle
// -----------------------------------------------------------------------------

export interface PersonalRecords {
  readonly addresses: Address[];
  readonly contacts: Contact[];
  readonly dependents: Dependent[];
  readonly qualifications: Qualification[];
  readonly identityDocuments: IdentityDocument[];
}

export async function fetchPersonalRecords(
  employeeId: string,
  signal?: AbortSignal,
): Promise<PersonalRecords> {
  const [addresses, contacts, dependents, qualifications, identityDocuments] = await Promise.all([
    fetchAddresses(employeeId, signal),
    fetchContacts(employeeId, signal),
    fetchDependents(employeeId, signal),
    fetchQualifications(employeeId, signal),
    fetchIdentityDocuments(employeeId, signal),
  ]);
  return { addresses, contacts, dependents, qualifications, identityDocuments };
}

export const DATE_ONLY = dbDate;
