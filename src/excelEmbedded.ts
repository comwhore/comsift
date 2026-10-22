import { App, Plugin, PluginManifest, TFile } from "obsidian";
import { installCsvLinks } from "./analysis/csvLinks";
import { cellTargetFromSubpath, type CellTarget } from "./analysis/cellRefs";
import * as excelBundle from "comsift-excel-bundle";

export type ComsiftExcelParent = Plugin & { setting: unknown; state: unknown };

type ExcelCtor = new (app: App, manifest: PluginManifest) => Plugin;

function excelConstructor(): ExcelCtor {
  const exported: { default?: unknown } = excelBundle;
  if (typeof exported.default !== "function") throw new Error("Embedded excel-modded did not export a default plugin class.");
  return exported.default as ExcelCtor;
}

/**
 * Runs the bundled excel-modded plugin's onload with storage merged under
 * `data.json` key `excel` so one comsift plugin owns both features.
 */
/** Returns an element for cell embeds (`X.sheet#A1:B2`), or null to keep the spreadsheet's own embed. */
export type CellEmbedHook = (file: TFile, link: string) => HTMLElement | null;

export async function mountEmbeddedExcel(parent: ComsiftExcelParent, cellEmbed?: CellEmbedHook): Promise<Plugin> {
  const ExcelPlugin = excelConstructor();
  const excel = new ExcelPlugin(parent.app, {
    ...parent.manifest,
    name: "comsheet",
  });

  excel.register = parent.register.bind(parent);
  excel.loadData = async () => {
    const raw = (await Plugin.prototype.loadData.call(parent)) as { excel?: unknown } | null;
    return raw?.excel ?? {};
  };
  excel.saveData = async (data: unknown) => {
    await Plugin.prototype.saveData.call(parent, {
      settings: parent.setting,
      state: parent.state,
      excel: data,
    });
  };

  // Read by the bundled embed post-processor before it renders a whole sheet.
  if (cellEmbed) (excel as Plugin & { comsiftCellEmbed?: CellEmbedHook }).comsiftCellEmbed = cellEmbed;
  // Read by the spreadsheet view's setEphemeralState: `[[X.sheet#B4:C6]]` opens with those cells selected.
  (excel as Plugin & { comsiftCellTarget?: (subpath: string) => CellTarget | null }).comsiftCellTarget = cellTargetFromSubpath;
  installCsvLinks(excel);
  await excel.onload();
  return excel;
}
