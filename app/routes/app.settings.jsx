import { useFetcher, useLoaderData } from "@remix-run/react";
import db from "../db.server";
import { json } from "@remix-run/node";
import { useEffect, useState } from "react";

// ⚠️ SINGLE STORE CONFIGURATION
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;

/* ======================= */
/*        LOADER           */
/* ======================= */
export async function loader({ request }) {
  // Validate environment variable
  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN in environment variables");
  }

  const shop = SHOPIFY_STORE_DOMAIN;

  // First try to find settings for this shop
  let setting = await db.setting.findUnique({
    where: { shop },
  });

  // If none exist, create defaults
  if (!setting) {
    setting = await db.setting.create({
      data: { shop },
    });
  }

  return json({ setting });
}

/* ======================= */
/*        ACTION           */
/* ======================= */
export async function action({ request }) {
  // Validate environment variable
  if (!SHOPIFY_STORE_DOMAIN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN in environment variables");
  }

  const formData = await request.formData();
  const shop = SHOPIFY_STORE_DOMAIN;

  const doubleEnabled = formData.get("enabled") === "true";

  const data = {
    doubleDraftOrdersEnabled: doubleEnabled,
    discount1: doubleEnabled ? parseFloat(formData.get("discount1") || "0") : 0,
    discount2: doubleEnabled ? parseFloat(formData.get("discount2") || "0") : 0,
    tag1: doubleEnabled ? String(formData.get("tag1") || "") : "",
    tag2: doubleEnabled ? String(formData.get("tag2") || "") : "",
    singleDiscount: doubleEnabled ? 0 : parseFloat(formData.get("singleDiscount") || "0"),
    singleTag: doubleEnabled ? "" : String(formData.get("singleTag") || ""),
  };

  await db.setting.update({
    where: { shop },
    data,
  });

  return json({ success: true });
}

/* ======================= */
/*       COMPONENT         */
/* ======================= */
export default function Settings() {
  const { setting } = useLoaderData();
  const fetcher = useFetcher();

  // View/Edit mode
  const [editing, setEditing] = useState(false);

  // Controlled state seeded from DB
  const [isEnabled, setIsEnabled] = useState(setting.doubleDraftOrdersEnabled);
  const [discount1, setDiscount1] = useState(setting.discount1 ?? 0);
  const [tag1, setTag1] = useState(setting.tag1 || "");
  const [discount2, setDiscount2] = useState(setting.discount2 ?? 0);
  const [tag2, setTag2] = useState(setting.tag2 || "");
  const [singleDiscount, setSingleDiscount] = useState(setting.singleDiscount ?? 0);
  const [singleTag, setSingleTag] = useState(setting.singleTag || "");
  const [justSaved, setJustSaved] = useState(false);

  // After a successful save, lock back and show success
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      setEditing(false);
      setJustSaved(true);
    }
  }, [fetcher.state, fetcher.data]);

  // If the server value changes (after revalidation), sync local fields when not editing
  useEffect(() => {
    if (!editing) {
      setIsEnabled(setting.doubleDraftOrdersEnabled);
      setDiscount1(setting.discount1 ?? 0);
      setTag1(setting.tag1 || "");
      setDiscount2(setting.discount2 ?? 0);
      setTag2(setting.tag2 || "");
      setSingleDiscount(setting.singleDiscount ?? 0);
      setSingleTag(setting.singleTag || "");
    }
  }, [setting, editing]);

  const onCancel = () => {
    setEditing(false);
    // restore from current DB snapshot
    setIsEnabled(setting.doubleDraftOrdersEnabled);
    setDiscount1(setting.discount1 ?? 0);
    setTag1(setting.tag1 || "");
    setDiscount2(setting.discount2 ?? 0);
    setTag2(setting.tag2 || "");
    setSingleDiscount(setting.singleDiscount ?? 0);
    setSingleTag(setting.singleTag || "");
  };

  const onSave = () => {
    const fd = new FormData();
    fd.append("enabled", String(isEnabled));

    if (isEnabled) {
      fd.append("discount1", String(discount1 || 0));
      fd.append("tag1", tag1);
      fd.append("discount2", String(discount2 || 0));
      fd.append("tag2", tag2);
    } else {
      fd.append("singleDiscount", String(singleDiscount || 0));
      fd.append("singleTag", singleTag);
    }

    setJustSaved(false);
    fetcher.submit(fd, { method: "post" });
  };

  const saving = fetcher.state !== "idle";

  return (
    <div
      style={{
        maxWidth: "600px",
        margin: "40px auto",
        padding: "24px",
        borderRadius: "12px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.1)",
        backgroundColor: "#fff",
        fontFamily: "sans-serif",
      }}
    >
      <h2 style={{ marginBottom: "1rem", fontSize: "1.5rem", fontWeight: 600 }}>
        Draft Order Settings
      </h2>

      {justSaved && !editing && (
        <div
          style={{
            marginBottom: "16px",
            background: "#d1fae5",
            padding: "12px",
            borderRadius: "8px",
            color: "#065f46",
            fontSize: "0.95rem",
          }}
        >
          ✅ Settings saved successfully.
        </div>
      )}

      {/* Toggle */}
      <Row label="Allow Double Draft Orders">
        <label style={{ position: "relative", width: 50, height: 28 }}>
          <input
            type="checkbox"
            checked={isEnabled}
            onChange={(e) => editing && setIsEnabled(e.target.checked)}
            style={{ opacity: 0, width: 0, height: 0 }}
            disabled={!editing}
          />
          <span
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: isEnabled ? "#4ade80" : "#d1d5db",
              borderRadius: 34,
              transition: "0.2s",
              cursor: editing ? "pointer" : "not-allowed",
            }}
          />
          <span
            style={{
              position: "absolute",
              height: 20,
              width: 20,
              left: isEnabled ? 26 : 4,
              bottom: 4,
              backgroundColor: "#fff",
              borderRadius: "50%",
              transition: "0.2s",
            }}
          />
        </label>
      </Row>

      {/* Fields */}
      {isEnabled ? (
        <>
          <Field
            label="Discount 1 (%)"
            type="number"
            value={discount1}
            onChange={(v) => setDiscount1(v)}
            disabled={!editing}
          />
          <Field label="Tag 1" value={tag1} onChange={setTag1} disabled={!editing} />
          <Field
            label="Discount 2 (%)"
            type="number"
            value={discount2}
            onChange={(v) => setDiscount2(v)}
            disabled={!editing}
          />
          <Field label="Tag 2" value={tag2} onChange={setTag2} disabled={!editing} />
        </>
      ) : (
        <>
          <Field
            label="Single Discount (%)"
            type="number"
            value={singleDiscount}
            onChange={(v) => setSingleDiscount(v)}
            disabled={!editing}
          />
          <Field
            label="Single Tag"
            value={singleTag}
            onChange={setSingleTag}
            disabled={!editing}
          />
        </>
      )}

      {/* Buttons */}
      <div style={{ marginTop: 20, display: "flex", gap: 12 }}>
        {editing ? (
          <>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              style={{
                padding: "10px 20px",
                backgroundColor: "#4f46e5",
                color: "#fff",
                borderRadius: 8,
                border: "none",
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? "Saving..." : "Save Settings"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              style={{
                padding: "10px 20px",
                backgroundColor: "#6b7280",
                color: "#fff",
                borderRadius: 8,
                border: "none",
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{
              padding: "10px 20px",
              backgroundColor: "#4f46e5",
              color: "#fff",
              borderRadius: 8,
              border: "none",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Edit Settings
          </button>
        )}
      </div>
    </div>
  );
}

/* ======================= */
/*   PRESENTATION HELPERS  */
/* ======================= */
function Row({ label, children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 16,
      }}
    >
      <label style={{ fontWeight: 500, fontSize: "1rem" }}>{label}</label>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, type = "text", disabled }) {
  const handle = (e) => {
    const v = e.target.value;
    onChange(type === "number" ? (v === "" ? "" : Number(v)) : v);
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <label>{label}</label>
      <input
        type={type}
        value={value}
        onChange={handle}
        step={type === "number" ? "0.01" : undefined}
        disabled={disabled}
        style={{
          width: "100%",
          padding: 8,
          borderRadius: 6,
          border: "1px solid #ccc",
          marginTop: 4,
          backgroundColor: disabled ? "#f3f4f6" : "#fff",
        }}
      />
    </div>
  );
}