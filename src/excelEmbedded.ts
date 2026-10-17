import { App, Plugin, PluginManifest } from "obsidian";
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
export async function mountEmbeddedExcel(parent: ComsiftExcelParent): Promise<Plugin> {
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

  await excel.onload();
  return excel;
}
