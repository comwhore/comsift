import { choiceField, findLayout, parseMappings, resolveColumns, savedMappingFor } from "../analysis/columnMapping";
import type { StoredProfile } from "../analysis/profileIdentity";

export const profileFieldName = (key: string) => key.replace(/^(?:id|column|note):/, "");
export const profileFieldLabel = (key: string) => profileFieldName(key).replace(/_/g, " ");

/** All three column toggles off means the field should not appear as a profile fact. */
export function visibleProfileFields(records: StoredProfile[], settings: { columnMapping: string; decisionIgnoredFields: string }): Record<string, string> {
  const mappings = parseMappings(settings.columnMapping);
  const ignored = new Set(settings.decisionIgnoredFields.split(",").map(key => profileFieldName(key.trim().toLowerCase())).filter(Boolean));
  const fields: Record<string, string> = {};
  for (const record of records) {
    const mapping = savedMappingFor(mappings, record.dataset);
    const columns = Object.entries(mapping).filter(([key]) => !key.startsWith("_")).map(([, column]) => column);
    const sourceColumns = columns.length ? columns : Object.keys(record.fields).map(profileFieldName);
    const choices = resolveColumns({ name: record.dataset, columns: sourceColumns }, mapping, findLayout(sourceColumns, mappings));
    for (const [key, value] of Object.entries(record.fields)) {
      const field = profileFieldName(key);
      const choice = choices.find(choice => choiceField(choice) === field);
      if (choice && !choice.identity && !choice.match && ignored.has(field.toLowerCase())) continue;
      if (typeof value === "string" && value.trim() && !fields[key]) fields[key] = value.trim();
    }
  }
  return fields;
}
