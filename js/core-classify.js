/* ============================================================
   core-classify.js — Clasificador universal de clases de paisaje.
   COPIA VERBATIM del proyecto de origen (app/js/main.js:10-65 del
   2026-07-24). No modificar la lógica: tolera los distintos esquemas
   GIS de cada campo (Unidad/UNIDAD/RASTER/nombres largos).
   Único cambio: el rango de diacríticos combinantes se escribe como
   ̀-ͯ (idéntico, pero sin caracteres invisibles en el fuente).
   ============================================================ */
"use strict";

/* ---------- Configuración de clases de paisaje ---------- */
const CLASS_META = {
  "agri":          { label: "Agrícola Secano",            legend: "#d9c98a" },
  "zona1":         { label: "Agrícola Secano · Zona 1",   legend: "#2e7d32" },
  "zona2":         { label: "Agrícola Secano · Zona 2",   legend: "#66bb6a" },
  "zona3":         { label: "Agrícola Secano · Zona 3",   legend: "#9ccc65" },
  "parche-le":     { label: "Parche Leñoso",              legend: "#1b4020" },
  "corr-le":       { label: "Corredor Leñoso",            legend: "#2f5d33" },
  "parche-herb":   { label: "Parche Herbáceo",            legend: "#6a7c48" },
  "corr-herb":     { label: "Corredor Herbáceo",          legend: "#947c4a" },
  "bajo":          { label: "Bajo en Recuperación",       legend: "#7c9a80" },
  "instalaciones": { label: "Instalaciones",              legend: "#b8b3a4" },
  "camino":        { label: "Caminos",                    legend: "#c9bd9e" },
  "otros":         { label: "Otros",                      legend: "#9e9e9e" }
};
/* Orden canónico para leyendas (se muestran solo las clases presentes) */
const CLASS_ORDER = ["agri", "zona1", "zona2", "zona3", "parche-le", "parche-herb",
  "corr-le", "corr-herb", "bajo", "instalaciones", "camino", "otros"];
const NATURE_CLASSES = ["parche-le", "corr-le", "parche-herb", "corr-herb"];
const WOODY_CLASSES = ["parche-le", "corr-le"];
const HERB_LIKE_CLASSES = ["parche-herb", "corr-herb", "bajo"];
const MISC_CLASSES = ["otros", "instalaciones", "camino"];

/* Clasificador universal: tolera las variantes de esquema de cada campo
   (Unidad/UNIDAD, nombres largos, con acentos, o solo códigos RASTER) */
function classify(props) {
  const raw = (props.Unidad || props.UNIDAD || props.unidad || "")
    .toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (raw && raw !== "no aplica") {
    if (/otros/.test(raw)) return "otros";
    if (/bajo/.test(raw)) return "bajo";
    if (/instalacion/.test(raw)) return "instalaciones";
    if (/camino/.test(raw)) return "camino";
    if (/parche.*herb/.test(raw)) return "parche-herb";
    if (/corr.*herb/.test(raw)) return "corr-herb";
    if (/parche/.test(raw)) return "parche-le";
    if (/corr/.test(raw)) return "corr-le";
    if (/(zona\s*-?1|z1)/.test(raw)) return "zona1";
    if (/(zona\s*-?2|z2)/.test(raw)) return "zona2";
    if (/(zona\s*-?3|z3)/.test(raw)) return "zona3";
    if (/(agricola|ag-secano|secano)/.test(raw)) return "agri";
  }
  switch (props.RASTER) {
    case 11: return "parche-le";
    case 12: return "corr-le";
    case 21: return "parche-herb";
    case 22: return "corr-herb";
    case 31: return "agri";
    case 311: return "zona1";
    case 312: return "zona2";
    case 313: return "zona3";
    case 41: return "instalaciones";
    case 42: return "camino";
    default: return "otros";
  }
}

/* Exposición dual navegador/Node (para la verificación en scratchpad).
   No introduce build ni módulos ES: sólo un footer inocuo. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CLASS_META, CLASS_ORDER, NATURE_CLASSES, WOODY_CLASSES,
    HERB_LIKE_CLASSES, MISC_CLASSES, classify };
}
