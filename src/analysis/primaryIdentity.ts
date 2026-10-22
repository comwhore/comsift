import { readProfileRecords, type StoredProfile } from "./profileIdentity";

/** A person's name and explicitly stored accounts are matching evidence, never inferred handles. */
export function primaryIdentity(path: string, text: string, metadata: Record<string, unknown> = {}): Array<StoredProfile & { is_primary: true }> {
  const records = readProfileRecords(text);
  const custom = strings(metadata.comsift_custom_fields);
  const title = typeof metadata.title === "string" ? metadata.title : text.match(/^# (.+)$/m)?.[1] || path.split("/").at(-1)!.replace(/\.md$/, "");
  const fields = { display_name: title, ...custom };
  if (!records.length) records.push({ id: `${path}:0`, dataset: path, row: 0, fields });
  else for (const record of records) record.fields = { ...record.fields, ...custom };
  const profiles: unknown[] = Array.isArray(metadata.comsift_profiles) ? metadata.comsift_profiles : [];
  const accounts: unknown[] = Array.isArray(metadata.comsift_accounts) ? metadata.comsift_accounts : [];
  for (const account of [...profiles, ...accounts]) {
    let values: Record<string, string>;
    if (typeof account === "string") {
      const separator = account.indexOf("|");
      if (separator < 0) continue;
      values = { platform: account.slice(0, separator), username: account.slice(separator + 1) };
    } else {
      values = strings(account);
      values.platform ||= values.service || "";
      values.profile_url ||= values.url || "";
    }
    if (!values.username && !values.profile_url) continue;
    const accountFields: Record<string, string> = { display_name: title, ...values, ...custom };
    if (records.some(record => record.fields.username === accountFields.username && record.fields.platform === accountFields.platform && record.fields.profile_url === accountFields.profile_url)) continue;
    const row = records.length + 1;
    records.push({ id: `${path}:account:${row}`, dataset: path, row, fields: accountFields });
  }
  return records.map(record => ({ ...record, is_primary: true }));
}

function strings(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
}
