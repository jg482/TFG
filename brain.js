/**
 * brain.js — Cerebro Determinista del Establo (SCADA, 0% IA)
 * ==========================================================
 * Guia de sintaxis rapida para leer este archivo sin saber JavaScript:
 *   - var nombre = valor;     -> Crea una variable (una "caja" con un numero o texto).
 *   - [a, b, c]               -> Lista (vector), donde el primer elemento es la posicion [0].
 *   - { clave: valor }        -> Paquete de datos (como un "struct" de MATLAB).
 *   - function nombre(datos)  -> Subrutina reutilizable (como una funcion .m de MATLAB).
 *   - if (...) { } else { }   -> "Si se cumple esta condicion haz esto; si no, lo otro".
 *   - for (i = 0; i < N; i++) -> Bucle: repite desde i = 0 hasta i = N-1 sumando 1 cada vuelta.
 *   - return resultado;       -> Devuelve el resultado y termina la funcion.
 */
"use strict"; // Obliga al navegador a avisar si escribimos mal el nombre de alguna variable

// Presion atmosferica media del aire en Molina de Aragon (~1060 m de altitud) [kPa]
var PATM = 89.5;

// Escalones fijos de temperatura exterior del Caso IIB de Skogestad [°C]
// Empieza en 0 °C durante 2000 s y luego va cambiando a cada valor de esta lista cada 4000 s
var SKOGESTAD_STEPS = [
  -2.5, -5.0, -10.0, -20.0, -30.0, -40.0, -30.0, -20.0, -10.0,
  -5.0, -2.5, 0.0, 5.0, 10.0, 15.0, 10.0, 5.0, 0.0,
];

// Datos climaticos de los 3 episodios de 96 horas (AEMET Aragon)
// Cada episodio guarda: humedad exterior fija (hrExt), humedad inicial (wExtInit),
// lista de horas clave (tH) y temperaturas exteriores en esas horas (T)
var CLIMA_PRESETS = {
  invierno: {
    hrExt: 83.7, wExtInit: 0.0040,
    tH: [0, 4, 8, 14, 20, 26, 32, 40, 48, 54, 58, 68, 78, 88, 96],
    T:  [0, -8, -19, -3, -11, -2, 3, -13, -2, -6, -12, -26, -14, -5, 0],
  },
  verano: {
    hrExt: 47.0, wExtInit: null, // null = calcularla automaticamente al inicio
    tH: [0, 6, 14, 22, 29, 38, 46, 53, 62, 70, 77, 86, 96],
    T:  [12, 18, 30, 19, 14, 34, 21, 16, 37, 20, 13, 29, 12],
  },
  verano_humedo: {
    hrExt: 83.7, wExtInit: null,
    tH: [0, 6, 14, 22, 29, 38, 46, 53, 62, 70, 77, 86, 96],
    T:  [12, 18, 28, 20, 15, 29, 20, 15, 28, 18, 13, 25, 12],
  },
};

// ============================================================================
// 1. UTILIDADES Y PSICROMETRIA (PROPIEDADES DEL AIRE HUMEDO)
// ============================================================================

// Recorta un numero x para que nunca baje de "min" ni suba de "max" (bloque Saturation)
function limitar(x, min, max) {
  if (x < min) { return min; } // Si se pasa por abajo, devuelve el minimo
  if (x > max) { return max; } // Si se pasa por arriba, devuelve el maximo
  return x;                    // Si esta dentro del rango, lo deja igual
}

// Lee un dato de configuracion; si viene vacio ("undefined" o "null"), usa el valor "defecto"
function leerDato(val, defecto) {
  if (val === undefined || val === null) { return defecto; }
  return val;
}

// Presion de vapor de saturacion del agua [kPa] segun temperatura T [°C] (formula Magnus)
function presionSaturacion(T) {
  return 0.61078 * Math.exp((17.27 * T) / (T + 237.3)); // Math.exp(u) significa e^u
}

// Calcula la Humedad Relativa interior RH [%] usando T [°C] y humedad absoluta w [kg agua/kg aire]
function calcularHR(T, w) {
  var pv = (w * PATM) / (0.622 + w);                 // Presion parcial que ejerce el vapor [kPa]
  var porcentaje = (pv / presionSaturacion(T)) * 100.0; // Porcentaje frente al maximo posible
  return limitar(porcentaje, 0.0, 100.0);            // Asegura que RH quede entre 0% y 100%
}

// Calcula el Indice Temperatura-Humedad (THI) para medir el estres por calor de las vacas
function calcularTHI(T, RH) {
  return (1.8 * T + 32.0) - (0.55 - 0.0055 * RH) * (1.8 * T - 26.8);
}

// Calcula la humedad absoluta del aire que entra de la calle [kg agua / kg aire seco]
function calcularWExterior(Tout, hrExt) {
  var pv = (hrExt / 100.0) * presionSaturacion(Tout); // Presion de vapor exterior [kPa]
  return (0.622 * pv) / (PATM - pv);                  // Formula psicrometrica inversa
}

// ============================================================================
// 2. PERFIL DE TEMPERATURA EXTERIOR Tout(t) EN CADA SEGUNDO
// ============================================================================

function obtenerTout(t, escenario, toutIni, toutFin, tEscalonH) {
  // Caso 1: Escalones clasicos de Skogestad
  if (escenario === "skogestad") {
    if (t < 2000.0) { return 0.0; } // Primeros 2000 s constantes a 0 °C
    // Math.floor redondea hacia abajo: cada 4000 s avanza 1 posicion en SKOGESTAD_STEPS
    var idx = Math.floor((t - 2000.0) / 4000.0);
    if (idx > 17) { idx = 17; }     // Hay 18 datos (indices del 0 al 17)
    return SKOGESTAD_STEPS[idx];
  }

  // Caso 2: Ensayo manual elegido por el usuario (un escalon a la hora "tEscalonH")
  if (escenario === "manual") {
    if (t < tEscalonH * 3600.0) { return toutIni; } // Antes del escalon -> Tout inicial
    return toutFin;                                 // Despues del escalon -> Tout final
  }

  // Caso 3: Invierno, Verano o Verano Humedo -> interpola linealmente entre las horas de la tabla
  var preset = CLIMA_PRESETS[escenario] || CLIMA_PRESETS.invierno;
  var tH = t / 3600.0; // Convertimos el tiempo actual de segundos a horas

  // Buscamos entre que dos horas (i e i+1) cae tH y hacemos una regla de tres lineal
  for (var i = 0; i < preset.tH.length - 1; i++) {
    if (tH <= preset.tH[i + 1]) {
      var tramo = (tH - preset.tH[i]) / (preset.tH[i + 1] - preset.tH[i]);
      return preset.T[i] + tramo * (preset.T[i + 1] - preset.T[i]);
    }
  }
  return preset.T[preset.T.length - 1]; // Si pasa de 96 h, devuelve el ultimo valor
}

// ============================================================================
// 3. CONTROLADORES PI (CON ANTI-WINDUP) Y SELECTORES ARC (MIN / MAX)
// ============================================================================

// Crea la lista de controladores PI del sistema (6 en Skogestad; 8 en CIGR con nebulizacion)
// Cada paquete guarda: id (nombre), act (actuador u1/u2/u3), pv (sensor que lee),
// sp (setpoint o consigna), P (ganancia proporcional), I (integral), Kt (anti-windup) y xI (valor acumulado)
function crearControladores(conCalorLatente) {
  var pis = [
    { id: "TC3", act: "u1", pv: "T",  sp: 5.0,    P: -10.0,       I: -10.0 / 350.0,        Kt: 1.0 / 350.0,  xI: 100.0 },
    { id: "CC2", act: "u1", pv: "c",  sp: 1000.0, P: -0.1,        I: -0.1 / 350.0,         Kt: 1.0 / 350.0,  xI: 10.0  },
    { id: "TC2", act: "u1", pv: "T",  sp: 0.0,    P: -10.0 / 3.0, I: -(10.0 / 3.0) / 1050, Kt: 1.0 / 1050.0, xI: 100.0 },
    { id: "CC1", act: "u1", pv: "c",  sp: 3000.0, P: -0.02,       I: -0.02 / 1750.0,       Kt: 1.0 / 1750.0, xI: 10.0  },
    { id: "TC1", act: "u1", pv: "T",  sp: 20.0,   P: -10.0,       I: -10.0 / 350.0,        Kt: 1.0 / 350.0,  xI: 100.0 },
    { id: "TC",  act: "u2", pv: "T",  sp: 4.0,    P: 22.0,        I: 22.0 / 350.0,         Kt: 1.0 / 350.0,  xI: 10.0  },
  ];

  // Si estamos en el Modelo 2 (CIGR), .push() anade 2 controladores mas para la nebulizacion u3
  if (conCalorLatente) {
    pis.push({ id: "TC4", act: "u3", pv: "T",  sp: 22.0, P: -22.0, I: -22.0 / 350.0, Kt: 1.0 / 350.0, xI: 0.0   });
    pis.push({ id: "CC4", act: "u3", pv: "RH", sp: 78.0, P: 5.0,   I: 5.0 / 350.0,   Kt: 1.0 / 350.0, xI: 100.0 });
  }
  return pis;
}

// Calcula que porcentaje mandar al ventilador (u1), calefactor (u2) y nebulizador (u3)
function calcularControlARC(pis, cMed, TMed, RHMed, conLatente, dt, actualizarIntegrador) {
  var v = {};   // Caja vacia donde guardaremos cuanto pide cada PI (ej: v.TC3)
  var err = {}; // Caja vacia donde guardaremos el error de cada PI (consigna - sensor)
  var i;

  // PASO 1: Calcular la salida de cada controlador PI por separado
  for (i = 0; i < pis.length; i++) {
    var med = TMed; // Por defecto suponemos que este controlador mide Temperatura
    if (pis[i].pv === "c") { med = cMed; }       // Si vigila CO2, coge la medida cMed
    else if (pis[i].pv === "RH") { med = RHMed; } // Si vigila humedad, coge la medida RHMed

    err[pis[i].id] = pis[i].sp - med; // Error = Consigna - Sensor
    // Salida PI paralela: Proporcional + Integrador acumulado, recortada a [-1000, +1000]
    v[pis[i].id] = limitar(pis[i].P * err[pis[i].id] + pis[i].xI, -1000.0, 1000.0);
  }

  // PASO 2: Red de selectores MIN / MAX para decidir el mando del ventilador u1
  // Parte del caudal nominal (50%) y va eligiendo segun prioridad de restricciones
  var sel = 50.0;
  var lazo = "NOMINAL";
  if (v.TC3 < sel) { sel = v.TC3; lazo = "TC3"; } // Baja ventilacion si T < 5 °C
  if (v.CC2 > sel) { sel = v.CC2; lazo = "CC2"; } // Sube ventilacion si CO2 > 1000 ppm
  if (v.TC2 < sel) { sel = v.TC2; lazo = "TC2"; } // Corta si riesgo congelacion (T < 0 °C)
  if (v.CC1 > sel) { sel = v.CC1; lazo = "CC1"; } // Emergencia sanitaria si CO2 > 3000 ppm
  if (v.TC1 > sel) { sel = v.TC1; lazo = "TC1"; } // Maximo caudal si hace calor (T > 20 °C)

  // En el Modelo CIGR fijamos un minimo higienico del 15%; en Skogestad puede bajar hasta 0%
  var u1Min = 0.0;
  if (conLatente) { u1Min = 0; }

  // Limitamos las senales fisicas reales de los actuadores entre su minimo y 100%
  var u1 = limitar(sel, u1Min, 100.0);
  var u2 = limitar(v.TC, 0.0, 100.0);
  var u3 = 0.0;
  if (conLatente) {
    // El nebulizador elige el menor entre pedir frio (TC4) y limitar humedad al 78% (CC4)
    u3 = limitar(Math.min(v.TC4, v.CC4), 0.0, 100.0);
  }

  // PASO 3: Actualizar la memoria integral (xI) de todos los PI con Anti-Windup
  // Si un PI perdio la seleccion o el actuador saturo, (uReal - v) frena su integrador
  if (actualizarIntegrador) {
    for (i = 0; i < pis.length; i++) {
      var uReal = u3;
      if (pis[i].act === "u1") { uReal = u1; }
      else if (pis[i].act === "u2") { uReal = u2; }

      var derivadaXI = pis[i].I * err[pis[i].id] + pis[i].Kt * (uReal - v[pis[i].id]);
      pis[i].xI = pis[i].xI + dt * derivadaXI; // Integracion de Euler: nuevo = viejo + dt * derivada
    }
  }

  return { u1: u1, u2: u2, u3: u3, lazo: lazo, v: v }; // Devolvemos los 3 mandos, el ganador y las salidas individuales de cada PI
}

// ============================================================================
// 4. MODELOS FISICOS DEL ESTABLO (LAS ECUACIONES DIFERENCIALES)
// ============================================================================

// Calcula con 15 iteraciones los valores iniciales (c, T, w) en equilibrio para arrancar el Modelo CIGR
function inicializarCIGR(Ncows, UA, Tout0, wExt0) {
  var u1_0 = 50.0;
  if (Tout0 >= 15.0) { u1_0 = 100.0; }            // Si hace >= 15 °C al empezar, suponemos u1 al 100%
  var q0 = 0.1 + (u1_0 / 100.0) * 14.9;           // Caudal de aire inicial [m³/s]

  // Semillas iniciales para empezar a iterar hasta encontrar el punto estacionario
  var T = Tout0 + 5.0;
  var w = wExt0 + 0.0020;
  var c = 950.0;

  for (var k = 0; k < 15; k++) {
    var thi = calcularTHI(T, calcularHR(T, w));

    // Produccion de leche estimada [kg/vaca/dia] segun frio o estres termico THI
    var Y1 = 25.0;
    if (thi > 68.0) { Y1 = Math.max(0.0, 25.0 - 0.5 * (thi - 68.0)); }
    else if (T < 0.0) { Y1 = Math.max(0.0, 25.0 + 0.25 * T); }

    // Potencia metabolica de la vaca (hpu) y reparto en calor total, sensible y vapor de agua
    var hpu = (5.6 * Math.pow(650.0, 0.75) + 22.0 * Y1 + 16.0) / 1000.0; // Math.pow(a,b) = a^b
    var Phi_tot = hpu * (1000.0 + 4.0 * (20.0 - T));
    var Phi_s = hpu * (0.71 * (1000.0 + 4.0 * (20.0 - T)) - 0.408 * Math.pow(Math.max(0.0, T), 2));
    var m_w = (Phi_tot - Phi_s) / ((2501.0 - 2.361 * T) * 1000.0);

    // Ecuaciones en estado estacionario (igualando derivadas a cero)
    c = 420.0 + (Ncows * 5e-5 * (hpu / 1.2869) * 1e6) / q0;
    T = Tout0 + (Ncows * Phi_s) / (1.08 * 1005.0 * q0 + UA);
    w = wExt0 + (Ncows * m_w) / (1.08 * q0);
  }
  return { c: c, T: T, w: w };
}

// MODELO 1: Skogestad original (sin calor latente) -> actualiza CO2 (est.c) y Temperatura (est.T)
function pasoSkogestad(est, u1, u2, Tout, Ncows, UA, Qhmax, dt) {
  var V = 3000.0;   // Volumen del establo [m³]
  var rho = 1.2;    // Densidad del aire estandar [kg/m³]
  var Cp = 1005.0;  // Calor especifico del aire [J/(kg·K)]

  // Convertimos % de actuadores a caudal real q [m³/s] y potencia calefactora Qh [W]
  var q = 0.1 + (u1 / 100.0) * 14.9;
  var Qh = (u2 / 100.0) * Qhmax;

  // Derivada de CO2 [ppm/s]: produccion de las vacas + renovacion con aire exterior (420 ppm)
  var dc = (Ncows * 5e-5 * 1e6 + q * (420.0 - est.c)) / V;

  // Derivada de temperatura [°C/s]: calor vacas (1000 W c/u) + calefactor - perdidas ventilacion y paredes
  var dT = (Ncows * 1000.0 + Qh) / (rho * Cp * V) - (q / V + UA / (rho * Cp * V)) * (est.T - Tout);

  // Integramos un paso "dt" con metodo de Euler (Math.max evita valores negativos de CO2)
  est.c = Math.max(0.0, est.c + dt * dc);
  est.T = est.T + dt * dT;
}

// MODELO 2: Modelo propio CIGR (con calor latente, humedad w y agua nebulizada u3)
// Si "avanzar" es false, solo calcula RH, THI y leche sin modificar el establo
function pasoCIGR(est, u1, u2, u3, Tout, wExt, Ncows, UA, Qhmax, dt, avanzar) {
  var V = 3000.0;   // Volumen del establo [m³]
  var rho = 1.08;   // Densidad del aire a ~1060 m de altitud [kg/m³]
  var Cp = 1005.0;  // Calor especifico del aire [J/(kg·K)]

  // Calculamos humedad relativa, indice THI y caida de leche (2% por punto encima de THI 72)
  var RH = calcularHR(est.T, est.w);
  var THI = calcularTHI(est.T, RH);
  var leche = Math.max(0.0, 25.0 - 0.5 * Math.max(0.0, THI - 72.0));

  // Si solo queriamos consultar estos indicadores actuales, devolvemos los datos y salimos
  if (!avanzar) {
    return { RH: RH, THI: THI, leche: leche, w_gkg: est.w * 1000.0 };
  }

  // Balance metabolico CIGR (vaca de 650 kg y 100 dias de gestacion) y calor latente h_fg [J/kg]
  var hpu = (5.6 * Math.pow(650.0, 0.75) + 22.0 * leche + 16.0) / 1000.0;
  var Phi_tot = hpu * (1000.0 + 4.0 * (20.0 - est.T)); // Calor total emitido por vaca [W]
  var Phi_s = hpu * (0.71 * (1000.0 + 4.0 * (20.0 - est.T)) - 0.408 * Math.pow(Math.max(0.0, est.T), 2)); // Parte sensible [W]
  var h_fg = (2501.0 - 2.361 * est.T) * 1000.0;        // Energia que absorbe 1 kg de agua al evaporarse

  // Convertimos % de control a magnitudes fisicas reales
  var q = 0.1 + (u1 / 100.0) * 14.9; // Caudal aire [m³/s]
  var Qh = (u2 / 100.0) * Qhmax;     // Potencia calefactor [W]
  var m_neb = (u3 / 100.0) * 0.0612; // Agua evaporada por nebulizacion [kg/s]

  // Tres ecuaciones diferenciales acopladas (dc/dt, dT/dt y humedad absoluta dw/dt)
  var dc = (Ncows * 5e-5 * (hpu / 1.2869) * 1e6 + q * (420.0 - est.c)) / V;
  var dT = (Ncows * Phi_s + Qh - m_neb * h_fg - (rho * Cp * q + UA) * (est.T - Tout)) / (rho * Cp * V);
  var dw = (Ncows * ((Phi_tot - Phi_s) / h_fg) + m_neb + rho * q * (wExt - est.w)) / (rho * V);

  // Avance de Euler un paso "dt"
  est.c = Math.max(0.0, est.c + dt * dc);
  est.T = est.T + dt * dT;
  est.w = Math.max(1e-6, est.w + dt * dw); // Minimo 1e-6 kg/kg para que no sea cero ni negativo

  return { RH: RH, THI: THI, leche: leche, w_gkg: est.w * 1000.0 };
}

// ============================================================================
// 5. MOTOR DE SIMULACION COMPLETA (A LA QUE LLAMA app.js)
// ============================================================================

function runSimulation(userCfg) {
  var t0Reloj = performance.now(); // Guarda la hora exacta de inicio para medir milisegundos

  // 1) Leemos los parametros que el usuario puso en la barra HTML (o valores por defecto)
  var cfg = userCfg || {};
  var modelType  = leerDato(cfg.modelType, "skogestad"); // "skogestad" o "latent"
  var scenario   = leerDato(cfg.scenario, "skogestad");  // "skogestad", "invierno", "verano", etc.
  var Ncows      = leerDato(cfg.Ncows, 80);              // Numero de vacas
  var UA         = leerDato(cfg.UA, 2000);               // Perdidas por paredes [W/K]
  var QhmaxW     = leerDato(cfg.QhmaxKw, 50) * 1000.0;   // Potencia calefactor [kW -> W]
  var toutIni    = leerDato(cfg.toutInit, 0);            // Tout inicial en ensayo manual [°C]
  var toutFin    = leerDato(cfg.toutStep, -20);          // Tout tras el escalon manual [°C]
  var tEscalonH  = leerDato(cfg.tStepHours, 4);          // Hora del escalon manual [h]
  var durHoras   = leerDato(cfg.durationHours, 24);      // Duracion ensayo manual [h]
  var conLat     = (modelType === "latent");             // true = Modelo 2 CIGR | false = Modelo 1 Skogestad

  // 2) Elegimos duracion total (segundos), paso de integracion dt y cada cuanto guardamos puntos
  var durSec = 345600; // 96 horas por defecto en ensayos climaticos
  if (scenario === "skogestad") { durSec = 74000; }
  else if (scenario === "manual") { durSec = durHoras * 3600; }

  // Paso de calculo dt: 0.5 s para Skogestad corto; 1.0 s para 96 h de CIGR
  var dt = 1.0;
  if (!conLat && durSec <= 80000) { dt = 0.5; }

  // Para que la grafica no tenga cientos de miles de puntos, guardamos 1 punto cada 20 s o 60 s
  var outDt = 60;
  if (durSec <= 90000) { outDt = 20; }

  // 3) Preparamos humedad exterior, controladores y el estado inicial del establo en t = 0
  var preset = CLIMA_PRESETS[scenario];
  var hrExt = leerDato(cfg.hrExt, 60);
  if (preset) { hrExt = preset.hrExt; } // Si es clima predefinido, usa su humedad oficial

  var pis = crearControladores(conLat);
  var Tout0 = obtenerTout(0.0, scenario, toutIni, toutFin, tEscalonH);

  var est = { c: 949.8, T: 7.2, w: 0.0 }; // Estado inicial del Modelo 1 (Skogestad)
  if (conLat) {
    var wExt0 = calcularWExterior(Tout0, hrExt);
    if (preset && preset.wExtInit !== null) { wExt0 = preset.wExtInit; }
    est = inicializarCIGR(Ncows, UA, Tout0, wExt0);
  }

  // 4) Cinta transportadora para simular el retardo de 1 segundo de los sensores
  // Si dt = 0.5 s necesitamos 2 huecos (0.5 + 0.5 = 1 s); si dt = 1.0 s basta 1 hueco
  var rh0 = 0.0;
  if (conLat) { rh0 = calcularHR(est.T, est.w); }
  var colaC = [est.c], colaT = [est.T], colaRH = [rh0];
  if (dt === 0.5) { colaC = [est.c, est.c]; colaT = [est.T, est.T]; colaRH = [rh0, rh0]; }

  // 5) Listas vacias donde iremos guardando la evolucion para dibujarla luego
  var out = {
    modelType: modelType, scenario: scenario, durationSec: durSec,
    t: [], Tout: [], T: [], CO2: [], RH: [], THI: [], milk: [], w_gkg: [],
    u1: [], u2: [], u3: [], activeLoop: [], vPI: [],
  };

  // 6) BUCLE PRINCIPAL EN EL TIEMPO (simula desde step = 0 hasta step = nSteps)
  var nSteps = Math.round(durSec / dt);       // Numero total de pasos de tiempo
  var cadaPasos = Math.round(outDt / dt);     // Cada cuantos pasos guardamos una muestra

  for (var step = 0; step <= nSteps; step++) {
    var t = step * dt; // Tiempo actual en segundos
    var Tout = obtenerTout(t, scenario, toutIni, toutFin, tEscalonH);
    var ultimo = (step === nSteps); // Sera true solo en la ultima vuelta del bucle

    // Calcula el control usando la medida mas antigua de la cola (cola[0], de hace 1 segundo)
    var ctrl = calcularControlARC(pis, colaC[0], colaT[0], colaRH[0], conLat, dt, !ultimo);

    // "%" es el resto de dividir: solo se cumple cada 20 s o 60 s para guardar puntos limpios
    if (step % cadaPasos === 0) {
      var diag = { RH: 0.0, THI: 0.0, leche: 25.0, w_gkg: 0.0 };
      if (conLat) { diag = pasoCIGR(est, ctrl.u1, ctrl.u2, ctrl.u3, Tout, 0.0, Ncows, UA, QhmaxW, dt, false); }

      // .push() anade el dato actual al final de cada lista
      out.t.push(t); out.Tout.push(Tout); out.T.push(est.T); out.CO2.push(est.c);
      out.RH.push(diag.RH); out.THI.push(diag.THI); out.milk.push(diag.leche); out.w_gkg.push(diag.w_gkg);
      out.u1.push(ctrl.u1); out.u2.push(ctrl.u2); out.u3.push(ctrl.u3); out.activeLoop.push(ctrl.lazo);
      out.vPI.push(ctrl.v);
    }

    // En la ultima vuelta ya hemos guardado el punto final: "break" sale del bucle
    if (ultimo) { break; }

    // Avanza un paso dt las ecuaciones del establo
    if (conLat) {
      pasoCIGR(est, ctrl.u1, ctrl.u2, ctrl.u3, Tout, calcularWExterior(Tout, hrExt), Ncows, UA, QhmaxW, dt, true);
    } else {
      pasoSkogestad(est, ctrl.u1, ctrl.u2, Tout, Ncows, UA, QhmaxW, dt);
    }

    // Actualiza la cinta de retardo de 1 s: .push() mete el nuevo por detras, .shift() saca el viejo por delante
    colaC.push(est.c); colaC.shift();
    colaT.push(est.T); colaT.shift();
    if (conLat) { colaRH.push(calcularHR(est.T, est.w)); colaRH.shift(); }
  }

  out.elapsedMs = performance.now() - t0Reloj; // Tiempo total que ha tardado la simulacion [ms]
  return out;
}

// Publicamos "BarnBrain" en la ventana del navegador para que app.js pueda llamarlo
window.BarnBrain = { CLIMA_PRESETS: CLIMA_PRESETS, SKOGESTAD_STEPS: SKOGESTAD_STEPS, runSimulation: runSimulation };
