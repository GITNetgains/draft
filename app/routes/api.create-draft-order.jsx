// app/routes/api.create-draft-order.jsx
import { json } from "@remix-run/node";
import { cors } from "remix-utils/cors";
import db from "../db.server";
import nodemailer from "nodemailer";


const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g., "yourstore.myshopify.com"
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // Your Admin API access token

export async function action({ request }) {
  console.log(`[${new Date().toISOString()}] Starting /api/create-draft-order`);

  // Validate environment variables
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    return await sendError(
      request,
      "Server configuration error: Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN",
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return await sendError(request, "Invalid JSON in request body", 400);
  }

  const { customer, cart, address, billingAddress, useShipping } = body;
  if (!cart?.items?.length) return await sendError(request, "Cart is empty", 400);

  // Use the single configured store and token
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

  const lineItems = cart.items.map((item) => ({
    quantity: item.quantity,
    variantId: `gid://shopify/ProductVariant/${item.variant_id}`,
  }));

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
                variant { id title image { url } }
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
    if (setting.doubleDraftOrdersEnabled) {
      // Create two orders only if both discounts are set > 0
      if (setting.discount1 > 0 && setting.discount2 > 0) {
        createdOrders.push(await createDraft(setting.discount1, "Discount Option 1", setting.tag1));
        createdOrders.push(await createDraft(setting.discount2, "Discount Option 2", setting.tag2));
      } else {
        // Fallback to single if double enabled but discounts not set
        createdOrders.push(await createDraft(setting.singleDiscount, "Your Discount", setting.singleTag));
      }
    } else {
      createdOrders.push(await createDraft(setting.singleDiscount, "Your Discount", setting.singleTag));
    }

    // Send Email
    let emailSent = false;

    console.log("Email check - Customer email:", customer?.email);
    console.log("Email check - SMTP_USER exists:", !!process.env.SMTP_USER);
    console.log("Email check - SMTP_PASS exists:", !!process.env.SMTP_PASS);

    if (customer?.email && process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        const transporter = nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        // Verify transporter connection
        await transporter.verify();
        console.log("SMTP connection verified successfully");

        const order = createdOrders[0];
        let itemsHtml = "";
        let total = 0;

        order.lineItems.edges.forEach(({ node }) => {
          const price = parseFloat(node.originalUnitPriceSet.shopMoney.amount);
          const lineTotal = price * node.quantity;
          total += lineTotal;
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

        const currency = order.totalPriceSet.shopMoney.currencyCode;
        const orderTotal = parseFloat(order.totalPriceSet.shopMoney.amount).toFixed(2);
        const shopName = shop.replace(".myshopify.com", "");

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

        console.log("Sending email to:", customer.email);
        
        const mailResult = await transporter.sendMail({
          from: `"${shopName}" <${process.env.SMTP_USER}>`,
          to: customer.email,
          subject: "Your order is ready – complete payment anytime!",
          html,
        });

        console.log("Email sent successfully:", mailResult.messageId);
        emailSent = true;
        
      } catch (emailErr) {
        console.error("Email failed:", emailErr.message);
        console.error("Full email error:", emailErr);
      }
    } else {
      console.log("Email skipped - missing requirements:", {
        hasCustomerEmail: !!customer?.email,
        hasSMTPUser: !!process.env.SMTP_USER,
        hasSMTPPass: !!process.env.SMTP_PASS,
      });
    }

    return await cors(
      request,
      json({ success: true, drafts: createdOrders, emailSent }),
      { origin: request.headers.get("Origin") || "*", methods: ["POST", "OPTIONS"] }
    );
  } catch (error) {
    console.error("Draft creation failed:", error.message);
    return await sendError(request, error.message, 500);
  }
}

// Helper to send consistent errors
async function sendError(request, message, status = 500) {
  return await cors(
    request,
    json({ success: false, error: message }, { status }),
    { origin: request.headers.get("Origin") || "*", methods: ["POST", "OPTIONS"] }
  );
}

// Handle CORS preflight
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        Vary: "Origin",
      },
    });
  }
  return new Response("Method Not Allowed", { status: 405 });
}