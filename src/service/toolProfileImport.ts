// Maigret / Sherlock results → connection profiles (one per found account) with a person card. The accounts
// are candidates, not verified, so each new profile is marked uncertain towards the person who was searched.
import { Notice, TFile } from "obsidian";
import type ComsiftPlugin from "../main";
import type { Investigation } from "./investigation";
import { markLinkTarget, readMarks, setMark, type SetMarkType } from "./personMarks";
import { inheritedRelation, personCanvasRelations } from "./canvasRelations";
import { parseToolReport, toolRecord, toolReportKind } from "./toolProfiles";
import type { ProfileRecord } from "../analysis/runner";

export class ToolProfiles {
  constructor(private plugin: ComsiftPlugin) {}

  /** Create or update profiles for these report notes. Returns the number of accounts imported. */
  async importReports(paths: string[]): Promise<number> {
    const { vault } = this.plugin.app;
    const groups = new Map<string, { item: Investigation; records: ProfileRecord[] }>();
    for (const path of paths) {
      const file = vault.getFileByPath(path);
      const item = this.plugin.investigations.forPath(path);
      if (!file || !item || !toolReportKind(path)) continue;
      const account = parseToolReport(path, await vault.read(file));
      if (!account?.fields.username && !account?.fields.profile_url) continue;
      const group = groups.get(item.id) ?? { item, records: [] };
      group.records.push(toolRecord(path, account));
      groups.set(item.id, group);
    }
    let count = 0;
    for (const { item, records } of groups.values()) {
      const files = await this.plugin.analysis.importProfileRecords(item, records);
      const primary = vault.getFileByPath(this.plugin.investigations.mdPath(item));
      // Typed arrows on the person's Canvas (usually pointing at the Maigret/Sherlock result) decide first.
      const relations = await personCanvasRelations(this.plugin, item);
      for (const file of new Set(files)) {
        if (primary) await this.markUncertain(file, primary, relations);
      }
      count += records.length;
    }
    return count;
  }

  /** All Maigret/Sherlock result notes of every person. */
  reportPaths(): string[] {
    return this.plugin.app.vault.getMarkdownFiles()
      .filter(file => toolReportKind(file.path) && !!this.plugin.investigations.forPath(file.path))
      .map(file => file.path);
  }

  /** Command and one-time upgrade: profiles for results saved before this existed. */
  async backfill(notify = true): Promise<number> {
    const count = await this.importReports(this.reportPaths());
    if (notify || count) new Notice(`Comsift: ${count} Maigret/Sherlock accounts are now connection profiles (marked uncertain).`, 8000);
    return count;
  }

  /**
   * Mark `file` uncertain towards the person once, unless it already has any mark towards them (or is their note).
   * When the person's Canvas already types the account or its source file (`relations`), no mark is added and an earlier automatic
   * uncertain mark is removed, so the Canvas arrow is what counts.
   */
  private async markUncertain(file: TFile, primary: TFile, relations = new Map<string, SetMarkType>()): Promise<void> {
    if (file.path === primary.path) return;
    const { metadataCache, fileManager } = this.plugin.app;
    const target = primary.path.replace(/\.md$/, "");
    const isPerson = (value: string) => {
      const link = markLinkTarget(value);
      return !!link && (link === target || link === primary.path || metadataCache.getFirstLinkpathDest(link, file.path)?.path === primary.path);
    };
    await fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      const sources = (Array.isArray(frontmatter.comsift_sources) ? frontmatter.comsift_sources as unknown[] : [frontmatter.comsift_sources])
        .map(markLinkTarget).filter((link): link is string => !!link)
        .flatMap(link => [link, `${link}.md`, metadataCache.getFirstLinkpathDest(link, file.path)?.path ?? link]);
      if (inheritedRelation(relations, file.path, sources)) {
        const auto = frontmatter.comsift_candidate_marked === true && readMarks(frontmatter).some(mark => mark.type === "uncertain" && isPerson(mark.value));
        if (auto) setMark(frontmatter, "none", `[[${target}]]`, isPerson);
        frontmatter.comsift_candidate_marked = true;
        return;
      }
      // Mark once only: if the user later removes the mark, a re-import must not bring it back.
      if (frontmatter.comsift_candidate_marked === true || readMarks(frontmatter).some(mark => isPerson(mark.value))) return;
      setMark(frontmatter, "uncertain", `[[${target}]]`, isPerson);
      frontmatter.comsift_candidate_marked = true;
    });
  }
}
