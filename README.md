# Calculadora de Márgenes — Productos en evaluación (ML / Falabella)

App de navegador para evaluar el margen de productos **que aún no están creados**, en etapa de sourcing.
Calcula en paralelo para **Mercado Libre** y **Falabella**.

## Cómo abrirla

La app es 100% estática (no necesita internet salvo nada — todos los datos están embebidos).

**Opción rápida (un computador):** doble clic en `index.html`.

**Opción equipo (recomendada):** levantar el mini-servidor incluido y compartir la URL en la red local:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8753
```
Luego abrir `http://localhost:8753/`. (También se puede subir la carpeta a cualquier hosting estático: Netlify, GitHub Pages, un bucket, etc.)

## Inputs
- **Nombre** del producto.
- **Categoría** (opcional): se predice automáticamente del nombre, por separado para ML y Falabella. Con API key configurada usa **IA (Claude)**, que entiende contexto y sinónimos (ej. "straps deporte" → Correas para Levantamiento, no accesorio de auto); sin key cae a deducción local por palabras. Botón "✨ Sugerir con IA" para re-ejecutar. Siempre puedes corregir en los selectores.
- **Dimensiones** del packaging (alto, ancho, largo en cm).
- **Peso físico** (kg).
- **Costo FOB unitario** (USD) por producto. El **factor CBM** (USD/m³) y el **dólar** (CLP/USD) viven en **Parámetros** porque cambian ~mensual. La app calcula el **landed cost** (COGS); el volumen por unidad (CBM/u) se deriva de las dimensiones del packaging.
- **Precio de venta** por canal (CLP, con IVA).
- Checkbox **Producto de supermercado** (solo afecta a ML, usa la tabla Full Super).

## Outputs (por canal)
COGS, comisión, costo de envío y margen — cada uno en **$ y %**. El margen se colorea: verde ≥20%, amarillo 10–20%, rojo <10%.

## Supuestos del modelo
- **IVA**: todo se calcula **sobre precios con IVA** (bruto), tal como aparecen en la publicación.
- **COGS** = landed cost calculado como en la planilla de costeo: **(FOB + CBM_unidad × factorCBM) × dólar × (1+IVA)**, donde CBM_unidad = alto×ancho×largo÷1.000.000, factorCBM es el precio de contenedor (USD/m³, input) e IVA=19% (editable en parámetros).
- **Comisión** = % de la categoría (archivos oficiales ML y Falabella).
- **Envío ML**: con reputación verde (50% dcto ya incluido). Se cobra **siempre**, según el peso y el tramo de precio: ≤$9.989, $9.990–$19.989, o ≥$19.990.
- **Envío Falabella**: cofinanciamiento logístico **FBS, reputación 5/5** (tabla vigente desde 26-jun-2026). Se cobra **siempre**, con tarifa distinta según precio <$19.990 o ≥$19.990.
- **Peso facturable** = el mayor entre el peso físico y el volumétrico, donde **volumétrico = largo×ancho×alto ÷ 4000** (fijo, no editable).

## Parámetros editables (panel inferior)
**Reputación de Falabella** (5/5), **IVA** (19%) y **API key de Anthropic** (el modelo Claude Haiku 4.5 es fijo). El factor CBM y el dólar son inputs que se recuerdan entre sesiones. Todo se guarda en el navegador (localStorage).

### Predicción de categoría con IA
Modelo **fijo**: **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) vía API de Anthropic.
1. Compra créditos y crea tu API key en https://console.anthropic.com (key `sk-ant-…`).
2. Abre **Parámetros**, pega la key en "API key de Anthropic" y **Guarda**. Se guarda solo en tu navegador (localStorage).
3. Al escribir el nombre (o con el botón "✨ Sugerir con IA", tras ~3 s), la IA predice la categoría de ML y Falabella entendiendo contexto y sinónimos.
4. Predice en **dos pasos**: (1) la IA elige el L1 de cada canal; (2) se le muestran las hojas REALES de ese L1 numeradas y elige por número — así reconoce sinónimos aunque el nombre difiera ("straps gym" → "Correas para Levantamiento"). Si un canal no da match confiable, cae a la deducción local por palabras. 2 requests por sugerencia; costo ~centavos.
5. Para un despliegue de equipo en web sin repartir keys, lo recomendable a futuro es un pequeño backend que guarde una sola key. Hoy cada navegador usa la key que se pegue en Parámetros.

## Estructura
```
index.html              UI + estilos
src/app.js              lógica de cálculo y deducción de categoría
src/ui.js               wiring del DOM, comparación, exportación
src/ai.js               predicción de categoría con IA (Claude API)
data/ml_categories.js   categorías + comisión ML (7.899, desde comisiones_ml_chile_v2.xlsx)
data/fbla_categories.js categorías + comisión Falabella
data/shipping.js        tablas de envío (ML normal, ML super, Falabella FBS)
serve.ps1               servidor estático opcional
```

## Limitaciones conocidas
- Tabla ML normal cargada hasta 110 kg; sobre eso usa el último tramo.
- ML Full Super sobre $19.990 se cobra con la tarifa de producto normal (tabla NO super).
- La deducción de categoría es aproximada (coincidencia de palabras, tolerancia a plurales, prioriza el sustantivo principal del título); siempre revisa/corrige el selector. Como muchos nombres de hoja se repiten en varios L1, el L1 sugerido puede no ser el ideal aunque la comisión suele coincidir.
- Comisiones ML: cuando una misma categoría (L1 + hoja) traía más de un %, se usó el valor más frecuente (empate → el mayor).
