// app/routes/api.create-draft-order.jsx
import { json } from "@remix-run/node";
import db from "../db.server";
import nodemailer from "nodemailer";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// OPTIMIZATION 1: Cache settings in memory (refresh every 5 minutes)
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedSettings(shop) {
  const now = Date.now();
  
  if (settingsCache && settingsCache.shop === shop && (now - settingsCacheTime) < CACHE_TTL) {
    return settingsCache;
  }
  
  let setting = await db.setting.findUnique({ where: { shop } });
  if (!setting) {
    setting = await db.setting.create({
      data: {
        shop,
        doubleDraftOrdersEnabled: false,
        discount1: 0,
        discount2: 0,
        tag1: "",
        tag2: "",
        singleDiscount: 0,
        singleTag: "",
      },
    });
  }
  
  settingsCache = setting;
  settingsCacheTime = now;
  return setting;
}

// ✅ FIXED: Better email transporter configuration
function getEmailTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("❌ SMTP_USER or SMTP_PASS not set");
    return null;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587, // ✅ FIXED: Use 587 instead of 465
      secure: false, // ✅ FIXED: false for port 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
      pool: false,
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });

    transporter.verify((error) => {
      if (error) {
        console.error("❌ SMTP verification failed:", error);
      } else {
        console.log("✅ SMTP ready");
      }
    });

    return transporter;
  } catch (error) {
    console.error("❌ Failed to create email transporter:", error);
    return null;
  }
}

function getCorsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

export async function action({ request }) {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting /api/create-draft-order`);

  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    return sendError(request, "Server configuration error", 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return sendError(request, "Invalid JSON in request body", 400);
  }

  const { customer, cart, address, billingAddress, useShipping } = body;
  if (!cart?.items?.length) return sendError(request, "Cart is empty", 400);

  const shop = SHOPIFY_STORE_DOMAIN;
  const accessToken = SHOPIFY_ADMIN_TOKEN;

  // OPTIMIZATION 3: Load settings from cache (faster than DB query)
  const setting = await getCachedSettings(shop);

  const endpoint = `https://${shop}/admin/api/2024-10/graphql.json`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": accessToken,
  };

  const lineItems = cart.items.map((item) => {
    const original = item.original_price / 100;
    const final = item.final_price / 100;
    const percentageOff = original > 0 ? ((original - final) / original) * 100 : 0;

    return {
      quantity: item.quantity,
      variantId: `gid://shopify/ProductVariant/${item.variant_id}`,
      priceOverride: {
        amount: original,
        currencyCode: cart.currency
      },
      appliedDiscount: item.total_discount > 0 ? {
        title: item.discounts?.[0]?.title || "Discount",
        description: "",
        value: Number(percentageOff.toFixed(2)),
        valueType: "PERCENTAGE"
      } : undefined,
    };
  });

  const shippingAddress = {
    firstName: customer?.first_name || "",
    lastName: customer?.last_name || "",
    address1: address?.address1 || "",
    address2: address?.apartment || "",
    city: address?.city || "",
    province: address?.state || "",
    country: address?.country || "",
    zip: address?.pin || "",
    company: address?.company || "",
  };

  const billingAddressInput = useShipping
    ? shippingAddress
    : {
        firstName: customer?.first_name || "",
        lastName: customer?.last_name || "",
        address1: billingAddress?.address1 || "",
        address2: billingAddress?.apartment || "",
        city: billingAddress?.city || "",
        province: billingAddress?.state || "",
        country: billingAddress?.country || "",
        zip: billingAddress?.pin || "",
        company: billingAddress?.company || "",
      };

  // OPTIMIZATION 4: Fetch only essential fields (less data = faster)
  const draftOrderMutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id 
          name 
          invoiceUrl 
          totalPriceSet { 
            shopMoney { amount currencyCode } 
          }
          lineItems(first: 50) {
            edges {
              node {
                title 
                quantity
                variant { 
                  id 
                  title
                  image { url(transform: { maxWidth: 100 }) }
                }
                originalUnitPriceSet { 
                  shopMoney { amount currencyCode } 
                }
              }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const createDraft = async (discount = 0, label = "Discount", tag = "") => {
    const input = {
      visibleToCustomer: false,
      lineItems,
      note: "Created via Draft Order App",
      tags: tag ? [tag] : [],
      shippingAddress,
      billingAddress: billingAddressInput,
      ...(customer?.id
        ? { customerId: `gid://shopify/Customer/${customer.id}` }
        : customer?.email
        ? { email: customer.email }
        : {}),
      ...(discount > 0 && {
        appliedDiscount: {
          title: label,
          description: label,
          value: parseFloat(discount),
          valueType: "PERCENTAGE",
        },
      }),
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: draftOrderMutation, variables: { input } }),
    });

    const data = await res.json();

    if (data.errors || data.data?.draftOrderCreate?.userErrors?.length) {
      const err = data.errors || data.data.draftOrderCreate.userErrors;
      throw new Error(JSON.stringify(err));
    }

    return data.data.draftOrderCreate.draftOrder;
  };

  try {
    let createdOrders = [];
    
    if (setting.doubleDraftOrdersEnabled && setting.discount1 > 0 && setting.discount2 > 0) {
      console.log("Creating DOUBLE draft orders (SWAPPED)");
      
      // Create 60% first, then 40%
      const [order60, order40] = await Promise.all([
        createDraft(setting.discount2, "FINAL60", setting.tag2 || ""),
        createDraft(setting.discount1, "PAYNOW40", setting.tag1 || "")
      ]);
      
      // Push in swapped order: 60% first, then 40%
      createdOrders.push(order60, order40);
      console.log(`✅ Created: ${order60.name} (60%), ${order40.name} (40%)`);
      
    } else {
      console.log("Creating SINGLE draft order");
      
      const order = await createDraft(
        setting.singleDiscount || 0, 
        "Your Discount", 
        setting.singleTag || ""
      );
      
      createdOrders.push(order);
    }

    console.log(`✓ Draft orders created in ${Date.now() - startTime}ms`);

    // ✅ FIXED: Pass full orders array, not just first order
    let emailSent = false;
    let emailError = null;

    if (customer?.email) {
      console.log(`📧 Attempting to send email to: ${customer.email}`);
      
      try {
        await sendEmailAsync(customer, createdOrders, shop, setting.doubleDraftOrdersEnabled);
        emailSent = true;
        console.log("✅ Email sent successfully");
      } catch (err) {
        emailError = err.message;
        console.error("❌ Email failed:", err.message);
      }
    } else {
      console.log("⚠️ No customer email provided");
    }

    return json(
      { 
        success: true, 
        drafts: createdOrders,
        timing: `${Date.now() - startTime}ms`,
        emailSent,
        emailError
      },
      { headers: getCorsHeaders(request) }
    );
  } catch (error) {
    console.error("❌ Draft creation failed:", error.message);
    return sendError(request, error.message, 500);
  }
}

async function sendEmailAsync(customer, orders, shop, isPartialPayment) {
  console.log("📧 sendEmailAsync called");
  console.log("   Customer:", customer?.email);
  console.log("   Orders count:", orders?.length);
  console.log("   Shop:", shop);

  const transporter = getEmailTransporter();
  
  if (!transporter) {
    throw new Error("Email transporter not available - check SMTP credentials");
  }

  // Use the first order (60% in partial payment scenario)
  const primaryOrder = orders[0];
  const hasMultipleOrders = orders.length > 1;

  console.log("📋 Primary order:", primaryOrder.name);

  let itemsHtml = "";
  primaryOrder.lineItems.edges.forEach(({ node }) => {
    const price = parseFloat(node.originalUnitPriceSet.shopMoney.amount);
    const lineTotal = price * node.quantity;
    const img = node.variant?.image?.url || "https://via.placeholder.com/80";

    itemsHtml += `
      <div style="display:flex; gap:16px; padding:12px 0; border-bottom:1px solid #eee;">
        <img src="${img}" width="60" height="60" style="object-fit:cover; border-radius:6px;">
        <div style="flex:1;">
          <div style="font-weight:600;">${node.title}</div>
          ${node.variant?.title !== "Default Title" ? `<div style="color:#666; font-size:14px;">${node.variant.title}</div>` : ""}
          <div style="color:#666; margin-top:4px;">Qty: ${node.quantity}</div>
        </div>
        <div style="font-weight:600;">${node.originalUnitPriceSet.shopMoney.currencyCode} ${lineTotal.toFixed(2)}</div>
      </div>`;
  });

  const currency = primaryOrder.totalPriceSet.shopMoney.currencyCode;
  const orderTotal = parseFloat(primaryOrder.totalPriceSet.shopMoney.amount).toFixed(2);
  
  const shopName = shop
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.myshopify\.com$/, "")
    .split('.')[0];

  console.log("🏪 Shop name:", shopName);

  const orderMessage = hasMultipleOrders 
    ? `Your order has been received. Thank you for choosing the Partial Payment option (40% now / 60% later). We will send the invoice for the initial 40% payment shortly, and the remaining 60% will be invoiced at the time of shipping. Please stay active on your email to receive regular updates about your order.`
    : `Your order has been received. Thank you for choosing the Partial Payment option (40% now / 60% later). We will send the invoice for the initial 40% payment shortly, and the remaining 60% will be invoiced at the time of shipping. Please stay active on your email to receive regular updates about your order.`;

  // Get both order numbers for partial payment
  const order40 = orders.length > 1 ? orders[1] : null;
  const order60 = orders.length > 1 ? orders[0] : null;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin:0; padding:0; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#f5f5f5;">
      <div style="max-width:600px; margin:0 auto; background:#fff; padding:32px;">
        
        <div style="text-align:center; margin-bottom:24px;">
          <h1 style="margin:0; font-size:24px; color:#333;">Your Order Has Been Received! </h1>
        
        </div>
        
        <p style="color:#333; line-height:1.6;">
          Hi ${customer?.first_name || "there"},
        </p>
        
        <p style="color:#333; line-height:1.6;">
          ${orderMessage}
        </p>
        
        ${hasMultipleOrders ? `
        <div style="background:#e3f2fd; border-left:4px solid #2196f3; padding:16px; margin:20px 0; border-radius:4px;">
          <strong style="color:#1976d2; font-size:16px;"> Your Draft Orders Created:</strong><br><br>
          <div style="color:#424242; line-height:1.8;">
            <div style="margin-bottom:8px;">
              <strong>First Payment (40%):</strong><br>
              <span style="color:#1976d2; font-weight:600;">Order ${order40.name}</span><br>
              <small style="color:#666;">Amount: ${order40.totalPriceSet.shopMoney.currencyCode} ${parseFloat(order40.totalPriceSet.shopMoney.amount).toFixed(2)}</small>
            </div>
            <div style="margin-top:12px;">
              <strong> Final Payment (60%):</strong><br>
              <span style="color:#1976d2; font-weight:600;">Order ${order60.name}</span><br>
              <small style="color:#666;">Amount: ${order60.totalPriceSet.shopMoney.currencyCode} ${parseFloat(order60.totalPriceSet.shopMoney.amount).toFixed(2)}</small><br>
              <small style="color:#ff6f00; font-style:italic;">(Invoice will be sent at time of shipping)</small>
            </div>
          </div>
        </div>
        ` : ''}
        
       
        <p style="color:#666; font-size:14px; line-height:1.6;">
          If you have any questions about your order, please don't hesitate to contact us.
        </p>
        
        <hr style="border:none; border-top:1px solid #eee; margin:24px 0;">
        
        <p style="color:#999; font-size:12px; text-align:center;">
          © 2026 sales@zioncases.com. All rights reserved.
        </p>
        
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: `"${shopName}" <${process.env.SMTP_USER}>`,
    to: customer.email,
    subject: hasMultipleOrders 
      ? `Order Received - Partial Payment (40% now / 60% later) - ${order40.name} & ${order60.name}` 
      : `Your order is ready – complete payment anytime!`,
    html,
  };

  console.log("📧 Sending email with options:", {
    from: mailOptions.from,
    to: mailOptions.to,
    subject: mailOptions.subject
  });

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Email sent successfully!");
    console.log("   Message ID:", info.messageId);
    console.log("   Response:", info.response);
    return info;
  } catch (error) {
    console.error("❌ Email sending failed:");
    console.error("   Error:", error.message);
    console.error("   Code:", error.code);
    console.error("   Command:", error.command);
    throw error;
  }
}

function sendError(request, message, status = 500) {
  return json(
    { success: false, error: message },
    { status, headers: getCorsHeaders(request) }
  );
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }
  return new Response("Method Not Allowed", { status: 405 });
}