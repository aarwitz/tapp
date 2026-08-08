const root = document.querySelector("#app");
const product = "Tapp Pro Plan";

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

function shell(content) {
  root.innerHTML = `<nav><strong>Tapp Commerce</strong><a href="/">Shop</a><a href="/orders">Orders</a></nav>${content}`;
}

function showShop() {
  shell(`<h1>Shop</h1><section class="card"><h2>${product}</h2><p class="price">$49</p><p class="muted">Representative revenue-critical fixture product.</p><a class="primary" href="/cart" aria-label="Buy ${product}">Buy ${product}</a></section>`);
}

function showCart() {
  shell(`<h1>Cart</h1><section class="card"><h2>${product}</h2><p class="price">$49</p><a class="primary" href="/checkout">Checkout</a></section>`);
}

function showCheckout() {
  shell(`<h1>Checkout</h1><section class="card"><h2>Review order</h2><p>${product}</p><p class="price">$49</p><button id="place-order">Place order</button></section>`);
  root.querySelector("#place-order").addEventListener("click", async () => {
    await api("/api/orders", { method: "POST", body: JSON.stringify({ product }) });
    window.location.assign("/confirmation");
  });
}

function showConfirmation() {
  shell(`<h1>Order confirmed</h1><section class="card"><p class="success">Your order was created.</p><strong>${product}</strong><p><a class="primary" href="/orders">Orders</a></p></section>`);
}

async function showOrders() {
  const { orders } = await api("/api/orders");
  shell(`<h1>Orders</h1><section class="card">${orders.length ? orders.map((order) => `<article><strong>${order.product}</strong><p class="muted">Order ${order.id}</p></article>`).join("") : '<p class="muted">No orders yet.</p>'}</section>`);
}

const routes = {
  "/": showShop,
  "/cart": showCart,
  "/checkout": showCheckout,
  "/confirmation": showConfirmation,
  "/orders": showOrders,
};
(routes[window.location.pathname] || showShop)();
