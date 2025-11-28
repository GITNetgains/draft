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
  <title>Your Order Has Been Received</title>
  <!-- Import Poppins font from Google Fonts -->
  <style type="text/css">
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
  </style>
</head>
<body style="margin:0; padding:0; font-family:'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color:#f5f5f5;">

  <!-- Outer wrapper with light background -->
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding: 20px 0;">
        
        <!-- Main Content Container (Max width 600px, white background) -->
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px; background-color:#ffffff; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
          <tr>
            <td style="padding: 30px 40px 10px 40px;" align="center">
              
              <!-- Logo Section -->
              <div style="text-align:center; margin-bottom:20px;">
                <img src="https://zioncaseswholesale.com/cdn/shop/files/Group_13526.png" alt="Zioncases Logo" width="150" height="40" style="display:block; margin:0 auto; max-width:150px; height:auto;">
              </div>
              
              <!-- Confirmation Title (Revised to remove icon) -->
              <h1 style="font-size: 26px; color: #36454F; margin: 0 0 10px 0; text-align: center; line-height: 1.2;">
                Your Order Has Been Received
              </h1>
              <p style="font-size: 14px; color: #666666; margin: 0 0 30px 0; text-align: center;">
                Partial Payment Option (40% now / 60% later) Selected
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 0 40px;">
              
              <!-- Greeting & Main Message -->
              <p style="color:#36454F; line-height:1.6; margin: 0 0 10px 0;">
                Hello ${customer?.first_name || "there"},
              </p>
              
              <p style="color:#36454F; line-height:1.6; margin: 0 0 30px 0;">
                ${orderMessage}
              </p>

              <!-- Conditional Draft Orders Section -->
              ${hasMultipleOrders ? `
                <div style="margin:20px 0;">
                  
                  <!-- First Payment Card (40%) -->
                  <div style="background-color:#FFF3F2; padding:20px; border-radius:10px; margin-bottom:15px; border: 1px solid #f9e2e0;">
                    <strong style="color:#ef3a24; font-size:16px; display:block; margin-bottom:8px;">First Payment (40%) - Invoice Coming Soon</strong>
                    <p style="color:#36454F; line-height:1.5; margin: 0 0 5px 0;">
                      <strong>Order ID:</strong> <span style="font-weight:600;">${order40.name}</span>
                    </p>
                    <p style="color:#36454F; line-height:1.5; margin: 0;">
                      <!-- Placeholder for Amount removed as requested -->
                    </p>
                  </div>
                  
                  <!-- Final Payment Card (60%) -->
                  <div style="background-color:#FFF3F2; padding:20px; border-radius:10px; border: 1px solid #f9e2e0;">
                    <strong style="color:#ef3a24; font-size:16px; display:block; margin-bottom:8px;">Final Payment (60%) - Invoiced at Shipping</strong>
                    <p style="color:#36454F; line-height:1.5; margin: 0 0 5px 0;">
                      <strong>Order ID:</strong> <span style="font-weight:600;">${order60.name}</span>
                    </p>
                    <small style="color:#78909c; font-style:italic; display:block; margin-top:5px;">
                      (Shipping will be calculated at checkout)
                    </small>
                  </div>
                </div>
              ` : ''}
              
             
              
              
              <!-- Final Closing Text -->
              <p style="color:#666666; font-size:14px; line-height:1.6; text-align:center; margin: 0 0 30px 0;">
                We will update you on the status of your order and shipping details via this email.
              </p>
            </td>
          </tr>
          
          <!-- Footer Section (Updated color) -->
          <tr>
            <td style="background-color:#090d1c; color:#ffffff; padding:20px 40px; text-align:center; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
              <p style="font-size:12px; margin: 0 0 5px 0;">
                &copy; 2025-2026 <a href="https://zioncaseswholesale.com/" style="color:#ffffff; text-decoration:none;">Zioncases.com</a>
              </p>
              <p style="font-size:12px; margin: 0;">
                Contact: <a href="mailto:sales@zioncases.com" style="color:#ffffff; text-decoration:underline;">sales@zioncases.com</a>
              </p>
            </td>
          </tr>
          
        </table>
        
      </td>
    </tr>
  </table>

</body>
</html>
  `;

  const mailOptions = {
    from: `"${shopName}" <${process.env.SMTP_USER}>`,
    to: customer.email,
    subject: hasMultipleOrders 
      ? `Partial Payment Order Recieved - 40% Now 60% Later ` 
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