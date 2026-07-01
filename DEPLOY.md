# Desplegar en Cloudflare Pages (URL para el equipo)

Objetivo: publicar la calculadora en `margenes.etbrands.cl` con la API key de Claude
**oculta en el servidor** (nadie pega keys). Tu dominio ya está en Cloudflare, así que es directo
y **no afecta** a Shopify (`etbrands.cl` / `www`) ni a ProfitGuard (`app.etbrands.cl`).

La carpeta ya incluye el proxy seguro en `functions/api/anthropic.js` (corre como Worker y guarda la key).

---

## Paso 1 — Subir el proyecto a GitHub
(Sin instalar nada; todo desde la web.)

1. Entra a https://github.com → **New repository** → nombre ej. `calculadora-margenes` → **Private** → Create.
2. En el repo vacío: **Add file → Upload files** → arrastra **todo el contenido** de esta carpeta
   (incluida la carpeta `functions/` y `data/`, `src/`, `index.html`) → **Commit changes**.

> Alternativa sin GitHub: en Cloudflare Pages puedes usar "Direct Upload", pero conectar GitHub
> es lo más confiable para que el proxy (Functions) se despliegue bien y se actualice solo.

## Paso 2 — Crear el proyecto en Cloudflare Pages
1. En Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.
2. Elige el repo `calculadora-margenes`.
3. Build settings:
   - **Framework preset:** None
   - **Build command:** (vacío)
   - **Build output directory:** `/`  (la raíz)
4. **Save and Deploy.** Te queda una URL tipo `calculadora-margenes.pages.dev`.

## Paso 3 — Poner la API key (oculta)
1. En el proyecto de Pages → **Settings → Variables and Secrets → Add**.
2. Nombre: `ANTHROPIC_API_KEY` · Valor: tu key `sk-ant-…` · tipo **Secret (encrypt)**.
3. Guarda y haz **Retry deployment** (o vuelve a desplegar) para que tome la variable.

> La key vive solo en Cloudflare. En la app publicada, **deja vacío** el campo "API key" de Parámetros:
> así usa el proxy. (Solo se pega una key a mano para pruebas locales.)

## Paso 4 — Subdominio `margenes.etbrands.cl`
1. En el proyecto de Pages → **Custom domains → Set up a custom domain**.
2. Escribe `margenes.etbrands.cl` → Continúa. Como `etbrands.cl` está en Cloudflare, **crea el DNS solo**.
3. En unos minutos queda con HTTPS. Listo: comparte `https://margenes.etbrands.cl` al equipo.

## Paso 5 (opcional, recomendado) — Limitar el acceso al equipo
Para que solo entre gente de ET Brands (y proteger el endpoint de IA):
1. Cloudflare **Zero Trust → Access → Applications → Add a self-hosted app**.
2. Dominio: `margenes.etbrands.cl`.
3. Policy: permitir **emails que terminen en `@etbrands.cl`** (login con Google). Gratis hasta 50 usuarios.

---

## Historial COMPARTIDO con el equipo (Cloudflare KV)
La pestaña **Historial** guarda todos los productos evaluados en **Cloudflare KV**
(base de datos propia, compartida para el equipo). Cada "+ Agregar / guardar" escribe un registro.

Pasos (una vez):
1. Cloudflare → **Storage & Databases → KV → Create namespace** (ej. `margenes-productos`).
2. Tu proyecto de Pages → **Settings → Bindings → Add → KV namespace**:
   - Variable name: **`MARGENES_KV`** (exacto)
   - KV namespace: el que creaste.
3. **Retry deployment** (Deployments → ⋯).

Listo: la Function `functions/api/products.js` guarda en KV y todos ven el mismo Historial.
El mismo binding `MARGENES_KV` también guarda los **parámetros compartidos** (factor CBM, dólar,
IVA, reputación Falabella) vía `functions/api/settings.js`, para que todo el equipo use los mismos
valores y el historial sea consistente. (La API key de IA es personal de cada navegador.)
Mientras no configures el binding, la app funciona con historial y parámetros locales de cada navegador.
Recomendado combinarlo con **Cloudflare Access** (paso 5) para limitar el acceso al equipo.

## Catálogo en vivo desde ProfitGuard (secret `PG_API_KEY`)
La pestaña **Catálogo** se llena con datos reales de ProfitGuard:
- **FOB (USD), proveedor y puerto** (una fila por combinación SKU+proveedor+puerto) vienen de la API
  de PG vía la Function server-side `functions/api/pg-sync.js`. **El COGS NO se toma de PG**: la app
  lo simula con el FOB real + el **factor CBM y el dólar de Parámetros**.
- **Dimensiones y precios Full/AON** vienen del **Excel de PG** (export "Productos"), que se cruza por SKU
  con el botón "Importar Excel". El **DOD** queda editable a mano (PG no lo expone).

Pasos (una vez):
1. En ProfitGuard, crear una **API key dedicada para la app** (no compartir la personal de nadie).
2. Cloudflare → tu proyecto de Pages → **Settings → Variables and Secrets → Add**:
   - Nombre: **`app-margenes-pg-api-key`** · Valor: la key de PG · tipo **Secret (encrypt)**.
   - (La Function también acepta `PG_API_KEY` si prefieres ese nombre.)
3. **Retry deployment** para que tome la variable.

Uso (cada vez que cambie el catálogo en PG):
1. En la app → pestaña **Catálogo** → **🔄 Sincronizar con ProfitGuard** (baja FOB/proveedor/puerto).
2. Luego **⬆ Importar Excel** (descargado de PG → "Productos") para completar dims y precios Full/AON.
   La comisión por categoría se deduce sola; los precios Full/AON/DOD son editables.

> La key de PG vive **solo** en Cloudflare (secret), nunca en el navegador ni en el repo. La Function
> corre en el servidor de Cloudflare, que **sí** puede llamar a `app.profitguard.cl` (a diferencia del
> sandbox). El sync usa ~6 requests (paginación de `product_sourcings`), bien bajo el límite de PG.

> Nota: dejamos de usar el Google Sheet/Apps Script (`google-apps-script.gs` y la variable
> `SHEETS_WEBHOOK_URL` quedaron sin uso; puedes borrar esa variable). Si más adelante quieres
> exportar, usa el botón "Exportar CSV" del Historial.

## Chile y Colombia (selector de país)
En la franja superior hay dos banderas (🇨🇱 Chile / 🇨🇴 Colombia). Al clickear una, la app cambia de país:
- **Parámetros propios** por país (factor CBM, dólar en CLP vs COP, IVA) — guardados por separado en KV
  (`settings` para Chile, `settings_co` para Colombia).
- **Base de datos propia** por país: Historial (`list` / `list_co`) y Catálogo (`catalog` / `catalog_co`).
- **Colombia = solo Mercado Libre** (se ocultan Falabella y el "súper"), con la **tabla de envío de ML Colombia**
  y precios en **COP**. Las categorías y comisiones se asumen iguales a Chile.

Todo usa el **mismo binding `MARGENES_KV`** (solo cambian las claves), así que no hay que crear nada nuevo para KV.

Para sincronizar el **Catálogo de Colombia** desde ProfitGuard hace falta un secret aparte:
- Cloudflare → Settings → Variables and Secrets → Add → nombre **`app-margenes-pg-api-key-co`** (Secret),
  con la API key de la instancia Colombia de ProfitGuard. (Mientras no exista, el Catálogo CO se llena
  importando el Excel; el sync CO devolverá "falta el secret".)

## Actualizar la app después
Cada vez que cambies algo: subes los archivos al repo de GitHub (Add file → Upload / commit) y
Cloudflare **redepliega solo** en ~1 min. El subdominio y la key se mantienen.

## Notas
- Costo: Cloudflare Pages + Functions es **gratis** en este volumen. Solo pagas el uso de Claude (centavos).
- El modelo está fijo en `claude-haiku-4-5-20251001` (en `functions/api/anthropic.js` y en `src/ai.js`).
- Datos (categorías, tablas de envío) van embebidos; no hay base de datos ni backend que mantener.
