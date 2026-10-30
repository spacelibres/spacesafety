import Link from "next/link";
import { notFound } from "next/navigation";

import { Topbar } from "@/components/Shell";
import { getTranslator } from "@/lib/i18n/registry";
import {
  FIELD_LABEL_KEYS,
  getWideObject,
  SOURCE_IDS,
  SOURCE_LABEL_KEYS,
  wideCatalogueAvailable,
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
  const decimals = field === "inclination_deg" ? 3 : field === "mass_kg" ? 1 : 4;
  return v.toFixed(decimals).replace(/\.?0+$/, "");
}

export default async function CatalogueObjectPage({
  params,
}: {
  params: Promise<{ norad: string }>;
}) {
  const { norad } = await params;
  const t = await getTranslator();
  const noradId = Number(norad);

  if (!wideCatalogueAvailable() || !Number.isFinite(noradId)) notFound();
  const object = getWideObject(noradId);
  if (!object) notFound();

  const title =
    object.fields.name.values.spacetrack ??
    object.fields.name.values.spacebook ??
    object.fields.name.values.discos ??
    `NORAD ${noradId}`;

  const sections: Array<{ idKey: string; heading: string; fields: WideField[] }> = [
    { idKey: "identity", heading: t.t("catalogue.sectionIdentity"), fields: PRIMARY },
    { idKey: "orbit", heading: t.t("catalogue.sectionOrbit"), fields: ORBIT },
    { idKey: "physical", heading: t.t("catalogue.sectionPhysical"), fields: PHYSICAL },
  ];

  const disagreements = Object.values(object.fields).filter((f) => f.disagrees).length;

  return (
    <>
      <Topbar section={t.t("nav.catalogue")} />
      <div className="content">
        <div className="page-head">
          <div>
            <h1 className="page-title">{title}</h1>
            <div className="crumb">
              <Link href="/catalogue">{t.t("nav.catalogue")}</Link>
              <span className="crumb-sep">/</span>
              <span className="mono">{noradId}</span>
            </div>
          </div>
          <span className="count">
            {t.t("catalogue.disagreements", { count: disagreements })}
          </span>
        </div>

        {sections.map((section) => (
          <div key={section.idKey} className="section">
            <div className="page-head section-head">
              <h2 className="page-title">{section.heading}</h2>
            </div>
            <div className="card">
              <div className="table-wrap">
                <table className="data wide">
                  <thead>
                    <tr>
                      <th>{t.t("catalogue.field")}</th>
                      {SOURCE_IDS.map((s) => (
                        <th key={s}>{t.t(SOURCE_LABEL_KEYS[s])}</th>
                      ))}
                      <th>{t.t("catalogue.chosen")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.fields.map((field) => {
                      const cmp = object.fields[field];
                      return (
                        <tr key={field}>
                          <td className="muted">{t.t(FIELD_LABEL_KEYS[field])}</td>
                          {SOURCE_IDS.map((s) => {
                            const value = cmp.values[s];
                            const isChosen = cmp.chosen === s;
                            return (
                              <td
                                key={s}
                                className={`mono-sm${isChosen ? " is-chosen" : ""}${
                                  value === null ? " is-absent" : ""
                                }`}
                              >
                                {format(value, field)}
                              </td>
                            );
                          })}
                          <td>
                            {cmp.chosen ? (
                              <span className={`chip ${cmp.disagrees ? "false" : "true"}`}>
                                {t.t(SOURCE_LABEL_KEYS[cmp.chosen])}
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

        <p className="footnote">{t.t("catalogue.footnote")}</p>
      </div>
    </>
  );
}
