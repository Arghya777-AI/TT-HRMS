/**
 * i18n keys owned EXCLUSIVELY by the me-edit-custom work. One file per author — `t()` is
 * typed on `keyof typeof en`, so concurrent appends to en.ts silently lose keys.
 *
 * Scope: making /me/profile/custom writable (direct write vs change request,
 * decided per field by the definition's own booleans) and letting an employee
 * file a document against a `document_types` row on /me/profile/documents.
 */
export const keysMeEditCustom = {
  // ---------------------------------------------------------------------------
  // E-07.5 · /me/profile/custom — editing
  // ---------------------------------------------------------------------------
  "profile.customEdit.subtitle":
    "Venue-specific details. Which of these you can change yourself is set per field by HR.",
  "profile.customEdit.card.hint":
    "A tick saves straight to your record. A shield goes to HR first. A padlock is HR's to set.",

  "profile.customEdit.value": "Value",
  "profile.customEdit.selectPlaceholder": "Choose one",
  "profile.customEdit.booleanOn": "Yes",
  "profile.customEdit.booleanOff": "No",
  "profile.customEdit.save": "Save",
  "profile.customEdit.saving": "Saving…",
  "profile.customEdit.request": "Send to HR",
  "profile.customEdit.requesting": "Sending…",
  "profile.customEdit.undo": "Undo",
  "profile.customEdit.editAria": "Change {label}",

  "profile.customEdit.saved": "{label} saved to your record.",
  "profile.customEdit.requested": "{label} sent to HR. The decision shows on your History tab.",

  "profile.customEdit.hint.self": "Saves immediately — no approval needed.",
  "profile.customEdit.hint.approval": "HR checks this before it goes on your record.",
  "profile.customEdit.hint.adminOnly": "HR sets this one. Ask them if it looks wrong.",
  "profile.customEdit.hint.pii":
    "Only you and HR see this value. Your manager's team view hides it.",
  "profile.customEdit.hint.required": "HR marks this one as required.",
  "profile.customEdit.hint.noClear":
    "A value can be corrected but not emptied here — ask HR to remove it.",
  "profile.customEdit.hint.options": "One of: {options}",
  "profile.customEdit.hint.range": "Between {min} and {max}.",
  "profile.customEdit.hint.min": "{min} or more.",
  "profile.customEdit.hint.max": "{max} or less.",

  "profile.customEdit.pending.title": "Waiting on HR",
  "profile.customEdit.pending.body": "You asked for “{value}” on {at}.",
  "profile.customEdit.pending.blocked":
    "This field already has a change waiting on HR. That one has to be decided before you can send another.",
  "profile.customEdit.failed":
    "HR approved your last change to this field but it could not be written: {error}. Tell HR — the request is still on record.",

  "profile.customEdit.error.empty": "Enter a value first.",
  "profile.customEdit.error.number": "Enter a number.",
  "profile.customEdit.error.min": "Must be {min} or more.",
  "profile.customEdit.error.max": "Must be {max} or less.",
  "profile.customEdit.error.date": "Enter a date.",
  "profile.customEdit.error.option": "Choose one of the listed options.",
  "profile.customEdit.error.pattern": "That doesn't match the format HR set for this field.",
  "profile.customEdit.error.unchanged": "That is already the saved value.",

  "profile.customEdit.unsupported.multiSelect":
    "This field holds several values at once, which this screen cannot yet edit. Ask HR to set it.",
  "profile.customEdit.unsupported.employeeRef":
    "This field points at a colleague. HR sets it, so the directory stays consistent.",
  "profile.customEdit.unsupported.file":
    "This field holds a file. Add it on the Documents tab and HR will link it here.",

  "profile.customEdit.refused.title": "The database refused this change",
  "profile.customEdit.refused.body":
    "Direct self-service writes on your own custom fields are not switched on for this project yet, so nothing was saved. Your value has not been lost — the button now sends it to HR, who can apply it for you.",

  // ---------------------------------------------------------------------------
  // E-07.6 · /me/profile/documents — uploading
  // ---------------------------------------------------------------------------
  "profile.docsUpload.card.title": "Add a document",
  "profile.docsUpload.card.hint":
    "Certificates, ID proofs and bank evidence. HR verifies what you add before it counts.",
  "profile.docsUpload.open": "Add a document",
  "profile.docsUpload.close": "Cancel",

  "profile.docsUpload.type": "Document type",
  "profile.docsUpload.typePlaceholder": "Choose a type",
  "profile.docsUpload.typeHint":
    "Only types HR lets employees supply are listed. Contracts and policies are issued to you, so they are not here.",
  "profile.docsUpload.title": "Title",
  "profile.docsUpload.titleHint": "What HR sees in their queue — not the file name.",
  "profile.docsUpload.file": "File",
  "profile.docsUpload.fileHint": "{types}, up to {mb} MB.",
  "profile.docsUpload.filePicked": "{name} · {size}",
  "profile.docsUpload.issueDate": "Issued on",
  "profile.docsUpload.expiryDate": "Valid until",
  "profile.docsUpload.expiryRequiredHint":
    "This type expires, so the valid-until date is required.",
  "profile.docsUpload.note": "Why you're adding it",
  "profile.docsUpload.noteHint":
    "At least 10 characters. It is recorded against your name in the audit trail and is what HR reads first.",

  "profile.docsUpload.submit": "Send to HR for verification",
  "profile.docsUpload.submitting": "Uploading…",
  "profile.docsUpload.done":
    "{title} sent to HR. It shows as awaiting verification until they check it.",

  "profile.docsUpload.error.type": "Choose a document type.",
  "profile.docsUpload.error.title": "Give it a title.",
  "profile.docsUpload.error.file": "Choose a file.",
  "profile.docsUpload.error.mime":
    "That file type isn't accepted for this document. Allowed: {types}.",
  "profile.docsUpload.error.size": "That file is {size}. The limit for this document is {mb} MB.",
  "profile.docsUpload.error.emptyFile": "That file is empty.",
  "profile.docsUpload.error.note": "Write at least 10 characters saying why.",
  "profile.docsUpload.error.expiry": "This type needs a valid-until date.",
  "profile.docsUpload.error.expiryOrder": "Valid-until has to be after the issue date.",
  "profile.docsUpload.error.issueFuture": "An issue date cannot be in the future.",
  "profile.docsUpload.error.checksum":
    "Your browser could not fingerprint the file, so it was not sent. Reload the page over HTTPS and try again.",
  "profile.docsUpload.error.orphan":
    "The file reached storage but could not be recorded against your record, so nothing has been added. Tell HR before trying again.",
  "profile.docsUpload.error.refused":
    "The database refused to record this document — employee uploads are not switched on for this project yet. The file reached storage but nothing was added to your record, so tell HR rather than trying again.",

  "profile.docsUpload.limits.title": "What happens to the file",
  "profile.docsUpload.limits.stored":
    "It goes into the private {bucket} bucket, in a folder only you can write to.",
  "profile.docsUpload.limits.review":
    "It arrives on HR's verification queue as awaiting review. Until they verify it, it proves nothing.",
  "profile.docsUpload.limits.noDownload":
    "You cannot re-open the file from here yet — downloads are short-lived signed links minted by the document-access function, which is not deployed on this project. HR can open it.",
  "profile.docsUpload.limits.scan":
    "Virus scanning stays pending until the scanner runs, so treat a fresh upload as unchecked.",

  "profile.docsUpload.pending.badge": "Awaiting HR verification",

  "profile.docsUpload.missing.title": "Still owed for onboarding",
  "profile.docsUpload.missing.hint":
    "Types HR marks as required for onboarding that your record does not have yet.",
  "profile.docsUpload.missing.none": "Nothing outstanding — every required type is on your record.",
  "profile.docsUpload.missing.required": "Required",
} as const;
