// Consulta de Power Query para una tabla del servidor de Lechuga & Co.
// Cambia "partidas" por: ventas, partidas, gastos, compras o productos.
let
    Tabla = "partidas",
    Origen = Json.Document(Web.Contents("http://localhost:8787/bi/" & Tabla)),
    ComoTabla = Table.FromRecords(Origen),
    Tipos = if Table.HasColumns(ComoTabla, "fecha")
        then Table.TransformColumnTypes(ComoTabla, {{"fecha", type date}})
        else ComoTabla
in
    Tipos
