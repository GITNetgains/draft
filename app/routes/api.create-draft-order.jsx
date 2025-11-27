// app/routes/api.create-draft-order.jsx
import { json } from "@remix-run/node";
import db from "../db.server";
import nodemailer from "nodemailer";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;


let emailTransporter = null;
function getEmailTransporter() {
  if (!emailTransporter && process.env.SMTP_USER && process.env.SMTP_PASS) {
    emailTransporter = nodemailer.createTransport({
      host: "smtp.netgains.org",
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      pool: true, 
      maxConnections: 5,
      maxMessages: 100,
    });
  }
  return emailTransporter;
}

// Manual CORS helper
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

  // Validate environment variables
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    return sendError(
      request,
      "Server configuration error: Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN",
      500
    );
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

  console.log(`Using configured store: ${shop}`);

  // Load or create settings
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

  const draftOrderMutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id name invoiceUrl createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id email firstName lastName }
          lineItems(first: 250) {
            edges {
              node {
                title quantity
               variant { 
  id 
  title 
  image { url }
  product {
    featuredImage { url }
  }
}

                originalUnitPriceSet { shopMoney { amount currencyCode } }
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
    
    // Check if double draft orders are enabled
    if (setting.doubleDraftOrdersEnabled && setting.discount1 > 0 && setting.discount2 > 0) {
      // Create TWO draft orders in PARALLEL (faster)
      console.log("Creating DOUBLE draft orders with discounts:", setting.discount1, setting.discount2);
      
      const [order1, order2] = await Promise.all([
        createDraft(setting.discount1, "PAYNOW40", setting.tag1 || ""),
        createDraft(setting.discount2, "FINAL60", setting.tag2 || "")
      ]);
      
      createdOrders.push(order1, order2);
      console.log("Two draft orders created successfully");
      
    } else {
      // Create SINGLE draft order
      console.log("Creating SINGLE draft order with discount:", setting.singleDiscount);
      
      const order = await createDraft(
        setting.singleDiscount || 0, 
        "Your Discount", 
        setting.singleTag || ""
      );
      
      createdOrders.push(order);
      console.log("Single draft order created successfully");
    }

    console.log(`Draft orders created in ${Date.now() - startTime}ms`);

    // OPTIMIZATION: Send email asynchronously (don't wait for it)
    if (customer?.email && process.env.SMTP_USER && process.env.SMTP_PASS) {
      // Fire and forget - don't await
      sendEmailAsync(customer, createdOrders[0], shop).catch(err => {
        console.error("Background email failed:", err.message);
      });
    }

    // Return immediately without waiting for email
    return json(
      { 
        success: true, 
        drafts: createdOrders,
        emailQueued: !!(customer?.email && process.env.SMTP_USER && process.env.SMTP_PASS)
      },
      { headers: getCorsHeaders(request) }
    );
  } catch (error) {
    console.error("Draft creation failed:", error.message);
    return sendError(request, error.message, 500);
  }
}

// OPTIMIZATION: Async email function (non-blocking)
async function sendEmailAsync(customer, order, shop) {
  try {
    const transporter = getEmailTransporter();
    if (!transporter) return;

    let itemsHtml = "";
    order.lineItems.edges.forEach(({ node }) => {
      const price = parseFloat(node.originalUnitPriceSet.shopMoney.amount);
      const lineTotal = price * node.quantity;
      const img =
  node.variant?.image?.url ||
  node.variant?.product?.featuredImage?.url ||
  "https://via.placeholder.com/80";


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

    const currency = order.totalPriceSet.shopMoney.currencyCode;
    const orderTotal = parseFloat(order.totalPriceSet.shopMoney.amount).toFixed(2);
  const shopName = shop
  .replace(/^https?:\/\//, "")   // remove http/https if included
  .replace(/^www\./, "")         // remove www.
  .replace(/\.myshopify\.com$/, "") // remove .myshopify.com
  .replace(/\.[^.]+$/, "");   

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
            <h1 style="margin:0; font-size:24px; color:#333;">Your Order is Ready!</h1>
            <p style="color:#666; margin-top:8px;">Order ${order.name}</p>
          </div>
          
          <p style="color:#333; line-height:1.6;">
            Hi ${customer?.first_name || "there"},
          </p>
          
          <p style="color:#333; line-height:1.6;">
            Thank you for shopping with ${shopName}! Your draft order has been created and is ready for payment.
          </p>
          
          <div style="background:#f9f9f9; border-radius:8px; padding:20px; margin:24px 0;">
            <h3 style="margin:0 0 16px 0; font-size:16px; color:#333;">Order Summary</h3>
            ${itemsHtml}
            <div style="display:flex; justify-content:space-between; padding-top:16px; font-weight:700; font-size:18px;">
              <span>Total</span>
              <span>${currency} ${orderTotal}</span>
            </div>
          </div>
          
          <div style="text-align:center; margin:32px 0;">
            <a href="${order.invoiceUrl}" style="display:inline-block; background:#000; color:#fff; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:600;">
              Complete Payment
            </a>
          </div>
          
          <p style="color:#666; font-size:14px; line-height:1.6;">
            If you have any questions about your order, please don't hesitate to contact us.
          </p>
          
          <hr style="border:none; border-top:1px solid #eee; margin:24px 0;">
          
          <p style="color:#999; font-size:12px; text-align:center;">
            © ${new Date().getFullYear()} ${shopName}. All rights reserved.
          </p>
          
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: `"${shopName}" <${process.env.SMTP_USER}>`,
      to: customer.email,
      subject: "Your order is ready – complete payment anytime!",
      html,
    });

    console.log("Email sent successfully to:", customer.email);
  } catch (err) {
    console.error("Email error:", err.message);
    throw err;
  }
}

// Helper to send consistent errors with CORS
function sendError(request, message, status = 500) {
  return json(
    { success: false, error: message },
    { status, headers: getCorsHeaders(request) }
  );
}

// Handle CORS preflight
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }
  return new Response("Method Not Allowed", { status: 405 });
}