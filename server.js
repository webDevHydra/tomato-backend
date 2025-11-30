// server.js (patched)
// FoodHub demo backend (Express + Socket.IO) — drop-in ready (patched)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ====== Configuration ======
const ALLOWED_ORIGINS = [
  'https://tomato-lime-seven.vercel.app/', // customer
  'https://tomato-restaurant-rho.vercel.app/', // restaurant
  'https://tomato-delivery-one.vercel.app/'  // delivery
];
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

// ====== Middleware ======
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGINS }));

// ====== Socket.IO ======
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// ====== In-memory stores (demo) ======
let restaurants = []; // each: { id, name, cuisine, rating, deliveryTime, isOpen, image, menu: [] }
let orders = [];      // each order object with id, restaurantId, customerId, items, status, etc.

// ====== Helper functions ======
function emitRestaurantsUpdated() {
  io.emit('restaurants_updated', restaurants);
  console.log('[io] restaurants_updated emitted (count:', restaurants.length, ')');
}

function findRestaurant(id) {
  return restaurants.find(r => String(r.id) === String(id));
}

function generateId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

function sanitizeOrderPayload(payload) {
  // Minimal mapping to server order shape
  return {
    id: payload.id || String(Date.now()),
    restaurantId: payload.restaurantId,
    restaurantName: payload.restaurantName || '',
    items: payload.items || [],
    total: payload.total || 0,
    status: payload.status || 'pending',
    createdAt: payload.createdAt || new Date().toISOString(),
    deliveryAddress: payload.deliveryAddress || '',
    customerId: payload.customerId,
    customerName: payload.customerName || '',
    deliveryPartnerId: payload.deliveryPartnerId || null
  };
}

// ====== REST API routes (plain + /api compatibility) ======

// Health
app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Tomato server running' }));

// --- Restaurants ---
// get all restaurants
app.get(['/restaurants', '/api/restaurants'], (req, res) => {
  return res.json(restaurants);
});

// create / update restaurant
// NOTE: If client doesn't provide id, server will generate it (fixes signup issue).
app.post(['/restaurants', '/api/restaurants'], (req, res) => {
  const r = req.body;
  if (!r) return res.status(400).json({ error: 'restaurant payload required' });

  // allow server to create id if not provided
  const id = String(r.id || generateId('rest_'));

  const idx = restaurants.findIndex(x => String(x.id) === String(id));
  const normalized = {
    id,
    name: r.name || r.restaurantName || 'Unnamed',
    cuisine: r.cuisine || r.type || '',
    rating: r.rating || 4.5,
    deliveryTime: r.deliveryTime || r.delivery || '30-45 min',
    isOpen: typeof r.isOpen === 'boolean' ? r.isOpen : true,
    image: r.image || r.photo || null,
    // support both menu and menuItems names
    menu: Array.isArray(r.menu) ? r.menu : (Array.isArray(r.menuItems) ? r.menuItems : [])
  };

  if (idx === -1) restaurants.push(normalized);
  else restaurants[idx] = { ...restaurants[idx], ...normalized };

  emitRestaurantsUpdated();
  return res.json(normalized);
});

// add menu item
app.post(['/restaurants/:id/menu', '/api/restaurants/:id/menu'], (req, res) => {
  const id = req.params.id;
  const menuItem = req.body;
  const rest = findRestaurant(id);
  if (!rest) return res.status(404).json({ error: 'restaurant not found' });

  rest.menu = rest.menu || [];
  // minimal validation for menu items
  const safeItem = {
    id: menuItem.id || generateId('item_'),
    name: menuItem.name || menuItem.title || 'Untitled',
    description: menuItem.description || menuItem.desc || '',
    price: Number(menuItem.price || 0),
    image: menuItem.image || null,
    category: menuItem.category || '',
    isVeg: typeof menuItem.isVeg === 'boolean' ? menuItem.isVeg : true,
    restaurantId: rest.id
  };
  rest.menu.push(safeItem);

  emitRestaurantsUpdated();
  return res.json(rest);
});

// --- Orders ---
// create order (REST)
app.post(['/orders', '/api/orders'], (req, res) => {
  const payload = req.body;
  if (!payload || !payload.customerId || !payload.restaurantId || !Array.isArray(payload.items)) {
    return res.status(400).json({ error: 'invalid order payload' });
  }

  const newOrder = sanitizeOrderPayload(payload);
  orders.push(newOrder);

  // **Emit both event names** for backwards compatibility:
  io.to(`restaurant:${newOrder.restaurantId}`).emit('order:new', newOrder);
  io.to(`restaurant:${newOrder.restaurantId}`).emit('new_order', newOrder);

  io.to(`customer:${newOrder.customerId}`).emit('order:created', newOrder);
  io.to(`customer:${newOrder.customerId}`).emit('order_created', newOrder);

  // Also emit global convenience events
  io.emit('order:new', newOrder);
  io.emit('new_order', newOrder);

  console.log('[rest] new order created', newOrder.id, '-> emitted to restaurant and customer rooms');
  return res.status(201).json(newOrder);
});

// get all orders (admin / debug)
app.get(['/orders', '/api/orders'], (req, res) => res.json(orders));

// get order by id
app.get(['/orders/:id', '/api/orders/:id'], (req, res) => {
  const o = orders.find(x => String(x.id) === String(req.params.id));
  if (!o) return res.status(404).json({ error: 'order not found' });
  return res.json(o);
});

// get orders by restaurant
app.get(['/orders/restaurant/:id', '/api/orders/restaurant/:id'], (req, res) => {
  const list = orders.filter(o => String(o.restaurantId) === String(req.params.id));
  return res.json(list);
});

// get orders by customer
app.get(['/orders/customer/:id', '/api/orders/customer/:id'], (req, res) => {
  const list = orders.filter(o => String(o.customerId) === String(req.params.id));
  return res.json(list);
});

// get available orders for delivery partners
app.get(['/delivery/available', '/api/delivery/available'], (req, res) => {
  const available = orders.filter(o => o.status === 'ready' && !o.deliveryPartnerId);
  return res.json(available);
});

// ====== Socket.IO real-time handlers ======
io.on('connection', (socket) => {
  console.log('[io] client connected', socket.id);

  // join-room / join (use either)
  socket.on('join-room', (payload) => {
    try {
      const { type, id } = payload || {};
      if (type && id) {
        const room = `${type}:${id}`;
        socket.join(room);
        console.log(`[io] ${socket.id} joined ${room}`);
      }
    } catch (e) {
      console.warn('[io] join-room error', e);
    }
  });

  socket.on('join', (payload) => {
    try {
      const { type, id } = payload || {};
      if (type && id) {
        const room = `${type}:${id}`;
        socket.join(room);
        console.log(`[io] ${socket.id} joined ${room} (alias join)`);
      }
    } catch (e) {
      console.warn('[io] join error', e);
    }
  });

  // Customer places a new order via socket (optional; REST is authoritative)
  socket.on('new_order', (order) => {
    try {
      const saved = sanitizeOrderPayload(order);
      orders.push(saved);

      // Emit both event names so clients listening to either will receive it
      io.to(`restaurant:${saved.restaurantId}`).emit('order:new', saved);
      io.to(`restaurant:${saved.restaurantId}`).emit('new_order', saved);

      io.to(`customer:${saved.customerId}`).emit('order:created', saved);
      io.to(`customer:${saved.customerId}`).emit('order_created', saved);

      // optional ack to emitter
      socket.emit('order_placed', { success: true, orderId: saved.id });
      console.log('[io] new_order received -> emitted to rooms', saved.id);
    } catch (e) {
      console.warn('[io] new_order handler error', e);
    }
  });

  // Restaurant registers (socket fallback) — also recommend calling REST /restaurants
  socket.on('restaurant_registered', (restaurant) => {
    try {
      const r = {
        id: String(restaurant.id || generateId('rest_')),
        name: restaurant.name || restaurant.restaurantName || 'Unnamed',
        cuisine: restaurant.cuisine || '',
        rating: restaurant.rating || 4.5,
        deliveryTime: restaurant.deliveryTime || '30-45 min',
        isOpen: typeof restaurant.isOpen === 'boolean' ? restaurant.isOpen : true,
        image: restaurant.image || null,
        menu: Array.isArray(restaurant.menu) ? restaurant.menu : (restaurant.menuItems || [])
      };

      const idx = restaurants.findIndex(x => String(x.id) === r.id);
      if (idx === -1) restaurants.push(r);
      else restaurants[idx] = { ...restaurants[idx], ...r };

      emitRestaurantsUpdated();
      console.log('[io] restaurant_registered processed for', r.id);
    } catch (e) {
      console.warn('[io] restaurant_registered error', e);
    }
  });

  // Restaurant updates menu via socket (fallback)
  socket.on('restaurant_menu_updated', (restaurant) => {
    try {
      const idx = restaurants.findIndex(x => String(x.id) === String(restaurant.id));
      if (idx >= 0) restaurants[idx] = { ...restaurants[idx], ...restaurant, menu: restaurant.menu || restaurants[idx].menu || [] };
      else restaurants.push({ ...restaurant, menu: restaurant.menu || [] });

      emitRestaurantsUpdated();
      console.log('[io] restaurant_menu_updated processed for', restaurant.id);
    } catch (e) {
      console.warn('[io] restaurant_menu_updated error', e);
    }
  });

  // Order status updates (restaurant or delivery partner)
  socket.on('order_status_updated', (updatedOrder) => {
    try {
      const idx = orders.findIndex(o => String(o.id) === String(updatedOrder.id));
      if (idx >= 0) {
        orders[idx] = { ...orders[idx], ...updatedOrder };
      } else {
        // If order not found, add as guard
        orders.push(updatedOrder);
      }

      // emit room-scoped updates
      if (updatedOrder.customerId) io.to(`customer:${updatedOrder.customerId}`).emit('order:update', updatedOrder);
      if (updatedOrder.restaurantId) io.to(`restaurant:${updatedOrder.restaurantId}`).emit('order:update', updatedOrder);
      if (updatedOrder.deliveryPartnerId) io.to(`delivery:${updatedOrder.deliveryPartnerId}`).emit('order:update', updatedOrder);

      // convenience general events (both names)
      io.emit('order_status_updated', updatedOrder);
      io.emit('order:status', updatedOrder);

      // additional notifications
      if (updatedOrder.status === 'ready' && !updatedOrder.deliveryPartnerId) {
        io.emit('order_ready_for_pickup', updatedOrder);
      }
      if (updatedOrder.status === 'picked_up') {
        io.emit('order_picked_up', updatedOrder);
      }
      if (updatedOrder.status === 'delivered') {
        io.emit('order_delivered', updatedOrder);
      }

      console.log('[io] order_status_updated', updatedOrder.id, '->', updatedOrder.status);
    } catch (e) {
      console.warn('[io] order_status_updated handler error', e);
    }
  });

  // Delivery partner accepts an order
  socket.on('delivery_accepted', ({ orderId, deliveryPartnerId }) => {
    try {
      const idx = orders.findIndex(o => String(o.id) === String(orderId));
      if (idx >= 0) {
        orders[idx].deliveryPartnerId = deliveryPartnerId;
        orders[idx].status = 'picked_up';
        const updated = orders[idx];
        io.to(`customer:${updated.customerId}`).emit('order:update', updated);
        io.to(`restaurant:${updated.restaurantId}`).emit('order:update', updated);
        io.to(`delivery:${deliveryPartnerId}`).emit('order:update', updated);
        console.log('[io] delivery_accepted', orderId, 'by', deliveryPartnerId);
      }
    } catch (e) {
      console.warn('[io] delivery_accepted error', e);
    }
  });

  // Location updates from delivery partners
  socket.on('location_update', ({ orderId, location }) => {
    try {
      const o = orders.find(o => String(o.id) === String(orderId));
      if (o) {
        io.to(`customer:${o.customerId}`).emit('delivery_location_updated', { orderId, location });
      }
      io.emit('delivery_location_updated', { orderId, location }); // general fallback
      console.log('[io] location_update for', orderId);
    } catch (e) {
      console.warn('[io] location_update handler error', e);
    }
  });

  // Basic auth mocks (keep for dev only)
  socket.on('customer_login', (credentials) => {
    socket.emit('auth_success', { type: 'customer', user: credentials });
  });
  socket.on('restaurant_login', (credentials) => {
    socket.emit('auth_success', { type: 'restaurant', user: credentials });
  });
  socket.on('delivery_login', (credentials) => {
    socket.emit('auth_success', { type: 'delivery', user: credentials });
  });

  socket.on('disconnect', (reason) => {
    console.log('[io] client disconnected', socket.id, 'reason:', reason);
  });
});

// ====== Error handler ======
app.use((err, req, res, next) => {
  console.error('[express] error', err);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ====== Start server ======
server.listen(PORT, () => {
  console.log(`🚀 FoodHub server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO ready — allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});

// ====== Graceful shutdown ======
process.on('SIGTERM', () => {
  console.log('SIGTERM received — closing server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

module.exports = { app, server, io };

