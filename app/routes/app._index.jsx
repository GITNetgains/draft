import { useLoaderData } from "@remix-run/react";
import { json } from "@remix-run/node";
import db from "../db.server";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Text,
  Card,
  Banner,
  BlockStack,
  Button,
  Box,
  Modal,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { Link } from "@remix-run/react";
import { OrderDraftIcon, PersonLockFilledIcon } from "@shopify/polaris-icons";

// ⚠️ SINGLE STORE CONFIGURATION
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// -------------------- SERVER-SIDE FUNCTIONS --------------------
async function fetchThemes(shop, accessToken) {
  try {
    const response = await fetch(`https://${shop}/admin/api/2024-10/themes.json`, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error("Themes API error:", response.status, await response.text());
      return [];
    }

    const data = await response.json();
    return data.themes || [];
  } catch (error) {
    console.error("Error fetching themes:", error);
    return [];
  }
}

async function fetchDraftOrdersCount(shop, accessToken) {
  const adminGraphQLEndpoint = `https://${shop}/admin/api/2024-10/graphql.json`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": accessToken,
  };

  const draftOrdersQuery = `
    query {
      draftOrders(first: 100, query: "note:'Created via Draft App'") {
        edges { node { id } }
      }
    }
  `;

  try {
    const draftRes = await fetch(adminGraphQLEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: draftOrdersQuery }),
    });

    if (!draftRes.ok) {
      console.error("Draft Orders GraphQL error:", draftRes.status, await draftRes.text());
      return 0;
    }

    const draftData = await draftRes.json();
    return draftData?.data?.draftOrders?.edges?.length || 0;
  } catch (error) {
    console.error("Error fetching draft orders:", error);
    return 0;
  }
}

// -------------------- REMIX LOADER --------------------
export async function loader({ request }) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN in environment variables");
  }

  const shop = SHOPIFY_STORE_DOMAIN;
  const accessToken = SHOPIFY_ADMIN_TOKEN;

  // Fetch themes
  const themesData = await fetchThemes(shop, accessToken);
  const publishedTheme = themesData.find((theme) => theme.role === "main") || {};

  // Fetch draft orders
  const draftOrderCount = await fetchDraftOrdersCount(shop, accessToken);

  // Fetch or create setting in DB
  let setting = await db.setting.findUnique({ where: { shop } });
  if (!setting) {
    setting = await db.setting.create({ data: { shop } });
  }

  return json({
    shop,
    publishedThemeId: publishedTheme.id || null,
    draftOrderCount,
    setting,
  });
}

// -------------------- DASHBOARD COMPONENT --------------------
export default function Dashboard() {
  const { shop, publishedThemeId, draftOrderCount, setting } = useLoaderData();

  const [active, setActive] = useState(false);
  const toggleModal = useCallback(() => setActive(!active), [active]);

  const appEmbedUUID = "5bd368d8-c46d-43e5-9bae-352b44a42a35";
  const themeEditorUrl =
    shop && publishedThemeId
      ? `https://${shop}/admin/themes/${publishedThemeId}/editor?context=apps&appEmbed=${encodeURIComponent(
          `${appEmbedUUID}/draft_button`
        )}&previewPath=/cart`
      : "";

  const handleOpenThemeEditor = () => {
    if (!themeEditorUrl) {
      alert("Unable to open Theme Customizer. Please ensure the theme is published and try again.");
      return;
    }
    window.open(themeEditorUrl, "_blank");
  };

  return (
    <Page fullWidth>
      <Box paddingBlockEnd="400" style={{ maxWidth: "1200px", margin: "0 auto" }}>
        <Text variant="headingXl" as="h1" fontWeight="bold">
          Hi, Welcome to Draft Order App
        </Text>
      </Box>

      <TitleBar title="Draft Order App Dashboard" />

      {/* Warning Banner */}
      <Banner title="Draft Order Button isn't showing up on your store yet" tone="warning" style={{ marginBottom: "13px" }}>
        <p>
          You activated Draft Order App but still need to enable the Draft Order button in the Shopify Theme Editor.
        </p>
        <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
          <Button onClick={handleOpenThemeEditor} variant="primary">
            Enable Draft Order Button
          </Button>
          <Button onClick={toggleModal} variant="primary">
            Check Instructions
          </Button>
        </div>
      </Banner>

      {/* Instructions Modal */}
      <Modal
        open={active}
        onClose={toggleModal}
        title="Action required: Enable Draft Order Button"
        size="large"
        primaryAction={{ content: "Go to Theme Editor", onAction: handleOpenThemeEditor }}
        secondaryActions={[{ content: "Enable later", onAction: toggleModal }]}
      >
        <Modal.Section>
          <div style={{ display: "flex", gap: "20px", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <Text as="h2" variant="headingMd">
                Draft Order Button isn't showing up on your store yet
              </Text>
              <p style={{ margin: "10px 0" }}>
                Complete the installation by enabling the Draft Order Button in your Shopify Theme Editor.
              </p>
              <ol style={{ paddingLeft: "18px", lineHeight: "1.6" }}>
                <li>Search <b>Draft Order Button</b> in App embeds</li>
                <li>Click the <b>Enable</b> toggle</li>
                <li>Click the <b>Save</b> button</li>
              </ol>
            </div>
            <div style={{ flex: 1 }}>
              <img
                src="/draft-order-instructions.png"
                alt="Enable Draft Order instructions"
                style={{ width: "100%", borderRadius: "8px", objectFit: "contain", borderLeft:"3px solid black" }}
              />
            </div>
          </div>
        </Modal.Section>
      </Modal>

      {/* Main Layout */}
      <Layout>
        {/* Setup Steps */}
        <Layout.Section>
          <Card title="App Setup Steps" sectioned>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd" fontWeight="bold">1. Enable the app</Text>
                <Text as="p" variant="bodyMd" color="subdued">
                  Go to Theme Customizer, App Embeds, and enable Draft Order Button App.
                </Text>
                <div style={{ marginTop: '8px' }}>
                  <Button onClick={handleOpenThemeEditor} size="medium" variant="primary">Open Theme Customizer</Button>
                </div>
              </BlockStack>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm" fontWeight="bold">2. Configure settings</Text>
                <Text as="p" variant="bodyMd" color="subdued">
                  Set up your draft order preferences including payment modes and discounts.
                </Text>
                <div style={{ marginTop: '8px' }}>
                  <Link to="/app/settings">
                    <Button size="medium" variant="primary">Configure Settings</Button>
                  </Link>
                </div>
              </BlockStack>

              <BlockStack gap="200">
                <Text as="h3" variant="heading" fontWeight="bold">3. Set Up Discounts & Tags</Text>
                <Text as="p" variant="bodyMd" color="subdued">
                  Create custom discounts and automatic tagging rules for different order types.
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Features Section */}
        <Layout.Section>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "1200px", margin: "0 auto" }}>
            <div style={{ display: "flex", gap: "15px", flexWrap: "wrap", justifyContent: "center" }}>

              {/* Draft Orders Card */}
              <div style={{ flex: "1", minWidth: "300px", backgroundColor: "white", borderRadius: "16px", padding: "28px 24px", boxShadow: "0 2px 6px rgba(0,0,0,0.08)", textAlign: "center" }}>
                <div style={{ marginBottom: "20px" }}>
                  <OrderDraftIcon width={64} height={64} />
                </div>
                <h3 style={{ fontSize: "18px", fontWeight: 600, marginBottom: "10px", color: "#202223" }}>
                  Draft Orders
                </h3>
                <p style={{ fontSize: "14px", color: "#5c5f62", lineHeight: "1.6" }}>
                  Customers can easily create draft orders that are automatically saved to your Shopify admin with all details.
                </p>
              </div>

              {/* Metrics Card */}
              <div style={{ flex: "1", minWidth: "300px", backgroundColor: "#f5f8faff", borderRadius: "16px", padding: "28px 24px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", textAlign: "center", color: "white", position: "relative", overflow: "hidden", opacity:"0.8" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "100%", background: "linear-gradient(135deg, rgba(242, 245, 246, 0.1) 0%, rgba(1, 113, 161, 0) 100%)", zIndex: 0 }}></div>
                <div style={{ position: "relative", zIndex: 1 }}>
                  <div style={{ width: "120px", height: "120px", borderRadius: "50%", border: "8px solid rgba(39, 38, 38, 0.2)", margin: "0 auto 20px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <div style={{ fontSize: "48px", fontWeight: "700", lineHeight: 1, color:"black" }}>
                      {draftOrderCount}
                    </div>
                  </div>
                  <div style={{ fontSize: "18px", fontWeight: "600", marginBottom: "8px", letterSpacing: "0.5px", color:"black" }}>
                    CUSTOMER DRAFT ORDERS
                  </div>
                  <div style={{ display: "inline-block", backgroundColor: setting.doubleDraftOrdersEnabled ? "#27AE60" : "#E74C3C", color: "white", fontSize: "14px", fontWeight: "600", padding: "6px 16px", borderRadius: "20px", marginTop: "12px" }}>
                    {setting.doubleDraftOrdersEnabled ? "Dual Order Mode Active" : "Single Order Mode Active"}
                  </div>
                </div>
              </div>

              {/* Integrations Card */}
              <div style={{ flex: "1", minWidth: "300px", backgroundColor: "white", borderRadius: "16px", padding: "28px 24px", boxShadow: "0 2px 6px rgba(0,0,0,0.08)", textAlign: "center" }}>
                <div style={{ marginBottom: "20px" }}>
                  <PersonLockFilledIcon width={64} height={64} />
                </div>
                <h3 style={{ fontSize: "18px", fontWeight: 600, marginBottom: "10px", color: "#202223" }}>
                  Advanced Order Rules
                </h3>
                <p style={{ fontSize: "14px", color: "#5c5f62", lineHeight: "1.6" }}>
                  Configure different payment rules, discounts, and tags for single or double draft orders.
                </p>
              </div>

            </div>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
