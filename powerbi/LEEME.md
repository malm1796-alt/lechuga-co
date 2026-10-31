# Power BI: tablero de Lechuga & Co.

Power BI Desktop lee los datos directo del servidor de la tienda. Solo funciona **en esta PC** y con el servidor encendido (`iniciar.bat`). Por seguridad, estas direcciones no responden por internet.

## 1. Conectar las tablas

En Power BI Desktop: **Inicio → Obtener datos → Web**. Pega cada dirección, elige **Convertir en tabla** y luego **Expandir columnas**. Repite con las cinco:

| Tabla        | Dirección                              | Qué trae                                                          |
|--------------|----------------------------------------|-------------------------------------------------------------------|
| `ventas`     | http://localhost:8787/bi/ventas        | Un renglón por ticket: fecha, hora, total, descuento, pago, canal, vendedor |
| `partidas`   | http://localhost:8787/bi/partidas      | Un renglón por prenda vendida: producto, categoría, temporada, talla, importe, costo y utilidad |
| `gastos`     | http://localhost:8787/bi/gastos        | Gastos del negocio y retiros del dueño (`es_retiro_dueno`)         |
| `compras`    | http://localhost:8787/bi/compras       | Compras de mercancía y ajustes de inventario (mermas)              |
| `productos`  | http://localhost:8787/bi/productos     | Catálogo con existencias y valor del inventario a costo           |

Atajo: en **Obtener datos → Consulta en blanco → Editor avanzado** pega el contenido de `consultas.pq` (cambia el nombre de la tabla en la última línea).

## 2. Tipos de dato

En Power Query, cambia `fecha` a **Fecha** y los importes a **Número decimal**. Marca la columna `ejemplo` de `ventas` para filtrar los datos de práctica.

## 3. Relaciones

- `partidas[venta_id]` → `ventas[venta_id]`
- `partidas[producto_id]` → `productos[producto_id]`
- Crea una tabla de calendario y relaciónala con `fecha` de ventas, partidas y gastos:

```DAX
Calendario = CALENDARAUTO()
```

## 4. Medidas sugeridas

```DAX
Ventas netas = SUM(partidas[importe])
Costo de lo vendido = SUM(partidas[costo])
Utilidad bruta = [Ventas netas] - [Costo de lo vendido]
Mermas = CALCULATE(SUM(compras[total]), compras[tipo] = "ajuste")
Gastos de operación = CALCULATE(SUM(gastos[monto]), gastos[es_retiro_dueno] = FALSE())
Utilidad neta = [Utilidad bruta] + [Mermas] - [Gastos de operación]
Margen neto % = DIVIDE([Utilidad neta], [Ventas netas])
Tickets = DISTINCTCOUNT(partidas[venta_id])
Ticket promedio = DIVIDE([Ventas netas], [Tickets])
Piezas vendidas = SUM(partidas[piezas])
Valor del inventario = SUM(productos[valor_inventario])
```

Estas medidas dan los mismos números que el estado de resultados de la caja.

## 5. Páginas del tablero

1. **Venta diaria:** tarjetas con Ventas netas, Tickets y Ticket promedio de hoy. Barras por día y una dona por forma de pago.
2. **Temporadas:** matriz de temporada × categoría con piezas, ventas y margen. Valor del inventario por temporada, para saber qué liquidar.
3. **Estado de resultados:** matriz por mes con Ventas, Costo, Utilidad bruta, Gastos y Utilidad neta.
4. **Canales:** Tienda contra WhatsApp.

## 6. Actualizar

Con el servidor encendido, presiona **Actualizar** en Power BI. Para que se actualice solo hace falta Power BI Service con una puerta de enlace (gateway) instalada en esta PC. Se puede agregar después.
