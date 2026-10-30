import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/Shell";
import {
  FIELD_LABELS,
  getWideObject,
  SOURCE_IDS,
  SOURCE_LABELS,
  wideCatalogueAvailable,
  type SourceId,
  type WideField,
} from "@/lib/wide-catalogue";

export const dynamic = "force-dynamic";

/** Fields shown in the identity block, in reading order. */
const PRIMARY: WideField[] = [
  "name",
  "cospar_id",
  "object_class",
  "country",
  "launch_site",
  "launch_date",
  "decay_date",
  "rcs_size",
];

const ORBIT: WideField[] = [
  "inclination_deg",
  "period_min",
  "apogee_km",
  "perigee_km",
  "orbit_type",
];

const PHYSICAL: WideField[] = [
  "mass_kg",
  "dry_mass_kg",
  "hard_body_radius_m",
  "cross_section_avg_m2",
  "cross_section_max_m2",
  "cross_section_min_m2",
  "span_m",
  "diameter_m",
  "length_m",
  "ballistic_coefficient",
  "shape",
  "manufacturer",
  "bus",
];

function format(v: string | number | null, field: WideField): string {
  if (v === null || v === "") return "—";
  if (typeof v === "string") return v;
  const decimals =
    field === "inclination_deg" ? 3 : field === "mass_kg" || field === "dry_mass_kg" ? 1 : 4;
  return v.toFixed(decimals).replace(/\.?0+$/, "");
}

export default async function CatalogueObjectPage({
  params,
}: {
  params: Promise<{ norad: string }>;
}) {
  const { norad } = await params;
  const noradId = Number(norad);

  if (!wideCatalogueAvailable() || !Number.isFinite(noradId)) notFound();
  const object = getWideObject(noradId);
  if (!object) notFound();

  const title =
    object.fields.name.values.spacetrack ??
    object.fields.name.values.spacebook ??
    object.fields.name.values.discos ??
    `NORAD ${noradId}`;

  const sections: Array<{ heading: string; fields: WideField[] }> = [
    { heading: "身份", fields: PRIMARY },
    { heading: "轨道", fields: ORBIT },
    { heading: "物理模型", fields: PHYSICAL },
  ];

  const totalDisagreements = Object.values(object.fields).filter((f) => f.disagrees).length;

  return (
    <>
      <Topbar section="编目数据库" />
      <div className="content">
        <div className="page-head">
          <h1 className="page-title">{title}</h1>
          <span className="count">
            NORAD {noradId} · {totalDisagreements} 个字段三源不一致
          </span>
        </div>

        <div style={{ marginBottom: 16 }}>
          <Link href="/catalogue" className="filter-btn">
            ← 返回编目列表
          </Link>
        </div>

        {sections.map((section) => (
          <div key={section.heading} style={{ marginBottom: 28 }}>
            <h2 className="page-title" style={{ fontSize: 15, marginBottom: 10 }}>
              {section.heading}
            </h2>
            <div className="card">
              <div className="table-wrap" style={{ borderTop: "none" }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 180 }}>字段</th>
                      {SOURCE_IDS.map((s) => (
                        <th key={s}>{SOURCE_LABELS[s].short}</th>
                      ))}
                      <th style={{ width: 130 }}>当前采用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.fields.map((field) => {
                      const cmp = object.fields[field];
                      return (
                        <tr key={field}>
                          <td className="muted">{FIELD_LABELS[field]}</td>
                          {SOURCE_IDS.map((s) => {
                            const value = cmp.values[s];
                            const isChosen = cmp.chosen === s;
                            return (
                              <td
                                key={s}
                                className="mono-sm"
                                style={{
                                  fontWeight: isChosen ? 600 : 400,
                                  opacity: value === null ? 0.35 : 1,
                                }}
                              >
                                {format(value, field)}
                              </td>
                            );
                          })}
                          <td>
                            {cmp.chosen ? (
                              <span className={`chip ${cmp.disagrees ? "false" : "true"}`}>
                                {SOURCE_LABELS[cmp.chosen as SourceId].short}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ))}

        <p className="muted" style={{ fontSize: 12 }}>
          三个来源的值原样保留，互不覆盖。「当前采用」为默认建议，可按对象逐字段更改。
        </p>
      </div>
    </>
  );
}
