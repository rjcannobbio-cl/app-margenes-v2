/* ============================================================
   Tablas de costo de envío — fuente: capturas oficiales ML / Falabella
   Todos los montos en CLP (con IVA, tal como aparecen).
   ============================================================ */

/* ---------- MERCADO LIBRE — productos normales (NO super) ----------
   Reputación verde (50% de descuento ya aplicado).
   maxKg = límite superior del tramo de peso facturable.
   t1 = precio ≤ $9.989   (solo aplica si se ofrece envío gratis)
   t2 = precio $9.990–$19.989 (solo aplica si se ofrece envío gratis)
   t3 = precio ≥ $19.990  (envío gratis obligatorio → lo paga el vendedor)
*/
window.ML_SHIP_NORMAL = [
  { maxKg: 0.3,  t1: 800,  t2: 1000, t3: 3050 },
  { maxKg: 0.5,  t1: 810,  t2: 1020, t3: 3150 },
  { maxKg: 1,    t1: 830,  t2: 1040, t3: 3250 },
  { maxKg: 1.5,  t1: 850,  t2: 1060, t3: 3400 },
  { maxKg: 2,    t1: 870,  t2: 1080, t3: 3600 },
  { maxKg: 3,    t1: 900,  t2: 1100, t3: 3950 },
  { maxKg: 4,    t1: 1040, t2: 1280, t3: 4550 },
  { maxKg: 5,    t1: 1180, t2: 1460, t3: 4900 },
  { maxKg: 6,    t1: 1330, t2: 1640, t3: 5200 },
  { maxKg: 8,    t1: 1470, t2: 1820, t3: 5800 },
  { maxKg: 10,   t1: 1590, t2: 1990, t3: 6200 },
  { maxKg: 15,   t1: 1740, t2: 2290, t3: 7200 },
  { maxKg: 20,   t1: 1890, t2: 2590, t3: 8500 },
  { maxKg: 25,   t1: 2040, t2: 2890, t3: 10000 },
  { maxKg: 30,   t1: 2190, t2: 3190, t3: 13050 },
  { maxKg: 40,   t1: 2390, t2: 3590, t3: 15000 },
  { maxKg: 50,   t1: 2590, t2: 3990, t3: 17300 },
  { maxKg: 60,   t1: 2790, t2: 4390, t3: 19000 },
  { maxKg: 70,   t1: 2990, t2: 4790, t3: 20000 },
  { maxKg: 80,   t1: 3190, t2: 5190, t3: 22300 },
  { maxKg: 90,   t1: 3390, t2: 5590, t3: 24200 },
  { maxKg: 100,  t1: 3590, t2: 5990, t3: 26300 },
  { maxKg: 110,  t1: 3790, t2: 6390, t3: 28400 }
];

/* ---------- MERCADO LIBRE — productos de supermercado (Full Super) ----------
   Solo válida para precio ≤ $19.990. Aplica a TODAS las ventas (aunque el
   comprador pague el envío). El costo nunca supera el 25% del precio.
   Columnas por tramo de precio:
   p1 ≤$1.989 | p2 $1.990–3.989 | p3 $3.990–6.989 | p4 $6.990–9.989 | p5 $9.990–13.989 | p6 $13.990–19.989
*/
window.ML_SHIP_SUPER = {
  priceBreaks: [1989, 3989, 6989, 9989, 13989, 19989],
  rows: [
    { maxKg: 2,      cols: [85,  160, 260, 410, 600,  825]  },
    { maxKg: 5,      cols: [100, 200, 350, 550, 750,  1000] },
    { maxKg: 8,      cols: [115, 250, 400, 625, 850,  1200] },
    { maxKg: Infinity, cols: [130, 275, 450, 700, 1000, 1300] }
  ]
};

/* ---------- FALABELLA — Cofinanciamiento logístico FBS (vigente 26-jun-2026) ----------
   maxKg = límite superior de la talla logística (peso facturable).
   menor = precio < $19.990   |  mayor = precio ≥ $19.990
   Cada arreglo: [5/5, 4/5, 3/5, 2/5] según reputación.
   El cofinanciamiento se cobra SIEMPRE (no es opcional como el envío gratis de ML).
   perKg=true en el último tramo: el valor es por kg, se multiplica por el peso.
*/
window.FBLA_SHIP = [
  { maxKg: 1,   menor: [1000, 1290, 2090, 2590],  mayor: [3000, 3790, 6090, 7590] },
  { maxKg: 2,   menor: [1000, 1290, 2090, 2590],  mayor: [3290, 3990, 6490, 8000] },
  { maxKg: 3,   menor: [1000, 1290, 2090, 2590],  mayor: [3490, 4190, 6790, 8490] },
  { maxKg: 6,   menor: [1390, 1690, 2790, 3490],  mayor: [3790, 4590, 7390, 9190] },
  { maxKg: 10,  menor: [2990, 3590, 5790, 7190],  mayor: [4190, 5090, 8190, 10190] },
  { maxKg: 15,  menor: [4990, 6090, 9790, 12190], mayor: [4990, 6090, 9790, 12190] },
  { maxKg: 20,  menor: [5990, 7290, 11790, 14690],mayor: [5990, 7290, 11790, 14690] },
  { maxKg: 30,  menor: [6990, 8490, 13690, 16990],mayor: [6990, 8490, 13690, 16990] },
  { maxKg: 50,  menor: [7990, 9690, 15590, 19390],mayor: [7990, 9690, 15590, 19390] },
  { maxKg: 80,  menor: [8990, 10890, 17590, 21790],mayor: [8990, 10890, 17590, 21790] },
  { maxKg: 100, menor: [9490, 11490, 18490, 22990],mayor: [9490, 11490, 18490, 22990] },
  { maxKg: 125, menor: [9990, 12090, 19490, 24190],mayor: [9990, 12090, 19490, 24190] },
  { maxKg: 150, menor: [11490, 13890, 22390, 27790],mayor: [11490, 13890, 22390, 27790] },
  { maxKg: 175, menor: [11490, 13890, 22390, 27790],mayor: [11490, 13890, 22390, 27790] },
  { maxKg: 200, menor: [12990, 15690, 25290, 31390],mayor: [12990, 15690, 25290, 31390] },
  { maxKg: 225, menor: [16990, 20490, 32990, 40890],mayor: [16990, 20490, 32990, 40890] },
  { maxKg: 250, menor: [16990, 20490, 32990, 40890],mayor: [16990, 20490, 32990, 40890] },
  { maxKg: 275, menor: [21990, 26490, 42590, 52790],mayor: [21990, 26490, 42590, 52790] },
  { maxKg: 300, menor: [21990, 26490, 42590, 52790],mayor: [21990, 26490, 42590, 52790] },
  { maxKg: 325, menor: [22990, 27690, 44590, 55290],mayor: [22990, 27690, 44590, 55290] },
  { maxKg: 350, menor: [22990, 27690, 44590, 55290],mayor: [22990, 27690, 44590, 55290] },
  { maxKg: 375, menor: [22990, 27690, 44590, 55290],mayor: [22990, 27690, 44590, 55290] },
  { maxKg: 400, menor: [22990, 27690, 44590, 55290],mayor: [22990, 27690, 44590, 55290] },
  { maxKg: 425, menor: [23990, 28890, 46490, 57590],mayor: [23990, 28890, 46490, 57590] },
  { maxKg: 450, menor: [23990, 28890, 46490, 57590],mayor: [23990, 28890, 46490, 57590] },
  { maxKg: 475, menor: [23990, 28890, 46490, 57590],mayor: [23990, 28890, 46490, 57590] },
  { maxKg: 500, menor: [23990, 28890, 46490, 57590],mayor: [23990, 28890, 46490, 57590] },
  { maxKg: 525, menor: [30990, 37290, 59990, 74290],mayor: [30990, 37290, 59990, 74290] },
  { maxKg: 550, menor: [30990, 37290, 59990, 74290],mayor: [30990, 37290, 59990, 74290] },
  { maxKg: 575, menor: [30990, 37290, 59990, 74290],mayor: [30990, 37290, 59990, 74290] },
  { maxKg: 600, menor: [30990, 37290, 59990, 74290],mayor: [30990, 37290, 59990, 74290] },
  { maxKg: Infinity, perKg: true, menor: [100, 120, 193, 239], mayor: [100, 120, 193, 239] }
];
