// web/avatar-showcase/src/bot/math.ts
var e = Math.PI * 2, t = (e, t = 0, n = 1) => e < t ? t : e > n ? n : e, n = (e, t, n) => e + (t - e) * n, r = {
	easeOutCubic: (e) => 1 - (1 - e) ** 3,
	easeInOutCubic: (e) => e < .5 ? 4 * e ** 3 : 1 - (-2 * e + 2) ** 3 / 2,
	easeOutQuint: (e) => 1 - (1 - e) ** 5
};
function i(t, n, r = 0) {
	let i = t / n * e;
	return .55 * Math.sin(i + r) + .3 * Math.sin(2 * i + r * 1.7 + 1.1) + .15 * Math.sin(3 * i + r * 2.3 + 2.4);
}
function a(e) {
	let t = e >>> 0;
	return () => {
		t = t + 1831565813 >>> 0;
		let e = Math.imul(t ^ t >>> 15, 1 | t);
		return e = e + Math.imul(e ^ e >>> 7, 61 | e) ^ e, ((e ^ e >>> 14) >>> 0) / 4294967296;
	};
}
var o = (e) => Math.round(e * 100) / 100;
// web/avatar-showcase/src/bot/decor.ts
function s(e, t = .55, n = .62) {
	let r = (e % 360 + 360) % 360, i = (1 - Math.abs(2 * n - 1)) * t, a = i * (1 - Math.abs(r / 60 % 2 - 1)), o = n - i / 2, [s, c, l] = r < 60 ? [
		i,
		a,
		0
	] : r < 120 ? [
		a,
		i,
		0
	] : r < 180 ? [
		0,
		i,
		a
	] : r < 240 ? [
		0,
		a,
		i
	] : r < 300 ? [
		a,
		0,
		i
	] : [
		i,
		0,
		a
	], u = (e) => Math.round((e + o) * 255).toString(16).padStart(2, "0");
	return `#${u(s)}${u(c)}${u(l)}`;
}
function c(t, n, r, i, a = 1) {
	let c = t.phase + n * t.speed * e, l = Math.cos(t.tilt), u = Math.sin(t.tilt), d = Math.sqrt(Math.max(0, 1 - t.k * t.k)), f = t.sweep * e, p = "", m = "", h = null;
	for (let e = 0; e <= 64; e++) {
		let n = c + e / 64 * f, i = Math.cos(n), a = Math.sin(n), s = t.a * (i * l + a * -u * t.k) + t.cx, g = t.a * (i * u + a * l * t.k) + t.cy, _ = t.a * a * d < 0, v = o(s * r), y = o(g * r), b = _ === h ? "L" : "M";
		_ ? m += `${b}${v} ${y}` : p += `${b}${v} ${y}`, h = _;
	}
	let g = Math.cos(t.tilt) * t.a * r, _ = Math.sin(t.tilt) * t.a * r;
	return {
		id: i,
		front: p,
		back: m,
		width: t.width * r,
		opacity: a,
		grad: {
			x1: o(t.cx * r - g),
			y1: o(t.cy * r - _),
			x2: o(t.cx * r + g),
			y2: o(t.cy * r + _),
			stops: [
				s(t.hue),
				s(t.hue + t.hueSpan * .5),
				s(t.hue + t.hueSpan)
			]
		}
	};
}
var l = a(659918), u = Array.from({ length: 6 }, (t, n) => ({
	a: 1.3 + l() * .1,
	k: .05 + l() * .4,
	tilt: n / 6 * Math.PI + l() * .5,
	speed: 3 + l() * .7,
	phase: l() * e,
	sweep: .6 + l() * .25,
	hue: n * 360 / 6 + l() * 30,
	hueSpan: 60 + l() * 60,
	width: .05 + l() * .012,
	cx: 0,
	cy: .1
})), d = Array.from({ length: 4 }, (e, t) => ({
	a: .78 + t * .2,
	k: .05 + t * .02,
	tilt: -.62 + t * .05,
	speed: .3,
	phase: .06 * t,
	sweep: .4,
	hue: 95 + t * 62,
	hueSpan: 100,
	width: .05,
	cx: 0,
	cy: -.12
})), f = [
	-.557,
	-.013,
	.532
], p = .165, m = 1.25, h = a(48879), g = Array.from({ length: 5 }, (t, n) => ({
	birth: n * .2,
	angle: h() * e,
	rho: .58 + h() * .18
}));
function _(e, n) {
	let r = [];
	for (let i of g) {
		let a = e - i.birth;
		if (a < 0 || a > .62) continue;
		let o = i.rho * .75 ** (a * 10), s = i.angle + a * 100 * Math.PI / 180;
		r.push({
			x: Math.cos(s) * o * n,
			y: Math.sin(s) * o * n,
			r: (.04 + .028 * t(a / .55)) * n,
			depth: t(1 - o / .8),
			opacity: t(a / .06) * t((.62 - a) / .08)
		});
	}
	return r;
}
var v = a(49383), y = Array.from({ length: 4 }, (e, t) => {
	let n = t - 1.5;
	return {
		a: .85 * (1 + n * .03),
		k: .15 / .85 * (1 + n * .16),
		tilt: 34 * Math.PI / 180 + n * .035,
		speed: 210 / 360,
		phase: -t * .045 + v() * .012,
		sweep: .34,
		hue: t * 85 + v() * 20,
		hueSpan: 80,
		width: .095,
		cx: 0,
		cy: 0
	};
}), b = .129, x = 1.003, S = .15, ee = 1.14, C = .054, w = 15.46, T = .186, E = .412, D = {
	yaw: 28.49,
	pitch: 28.62,
	roll: -13
}, O = (e) => e * Math.PI / 180;
function k(e, t, n) {
	let r = Math.cos(n), i = Math.sin(n);
	return [[
		e[0] * r + t[0] * i,
		e[1] * r + t[1] * i,
		e[2] * r + t[2] * i
	], [
		t[0] * r - e[0] * i,
		t[1] * r - e[1] * i,
		t[2] * r - e[2] * i
	]];
}
function te(e, t, n = w) {
	let r = [
		0,
		0,
		1
	], i = [
		1,
		0,
		0
	], a = [
		0,
		1,
		0
	];
	[r, i] = k(r, i, O(e.yaw)), [a, r] = k(a, r, O(e.pitch)), [i, a] = k(i, a, O(e.roll));
	let o = (e) => {
		let [o, s] = k(r, i, O(n * e));
		return {
			x: o[0] * t,
			y: o[1] * t,
			a: s[0],
			b: s[1],
			c: a[0],
			d: a[1],
			depth: o[2]
		};
	};
	return [o(-1), o(1)];
}
var A = a(24301), ne = (() => {
	let e = [], t = 1.4;
	for (; t < 900;) e.push(t), t += 1.9 + A() * 2.7, A() < .18 && (e.push(t), t += .24);
	return e;
})(), re = .18;
function ie(e) {
	for (let t = 0; t < ne.length; t++) {
		let n = ne[t];
		if (e < n) break;
		let r = (e - n) / re;
		if (r >= 0 && r <= 1) return r < .45 ? 1 - r / .45 : (r - .45) / .55;
	}
	return 1;
}
function ae(e, t = {}) {
	let { wander: n = 1, blink: r = !0, float: a = !0 } = t;
	return {
		dYaw: (i(e, 11.3, .4) * 5.5 + i(e, 3.7, 2.1) * 1.6) * n,
		dPitch: (i(e, 9.1, 1.3) * 4.2 + i(e, 4.3, .7) * 1.3) * n,
		dRoll: i(e, 13.7, 3.2) * 2.2 * n,
		lid: r ? ie(e) : 1,
		driftX: a ? i(e, 7.9, 1.9) * .006 : 0,
		driftY: a ? i(e, 5.3, .3) * .007 : 0,
		breath: a ? 1 + Math.sin(e / 3.4 * Math.PI * 2) * .005 : 1
	};
}
function oe(e) {
	return .06 + .94 * t(e);
}
// web/avatar-showcase/src/bot/expressions.ts
var j = (e, t, n = 0, r = 1) => ({
	w: e,
	h: t,
	tilt: n,
	open: r
}), M = (e, t, n = 0, r = 1) => [j(e, t, n, r), j(e, t, -n, r)], se = [
	{
		id: "neutre",
		gaze: { ...D },
		split: w,
		eyes: [j(T, E), j(T, E)]
	},
	{
		id: "attentif",
		gaze: {
			yaw: 4,
			pitch: 5,
			roll: -4
		},
		split: 16,
		eyes: M(.21, .44)
	},
	{
		id: "surpris",
		gaze: {
			yaw: 3,
			pitch: -3,
			roll: 0
		},
		split: 19,
		eyes: M(.45, .47)
	},
	{
		id: "excite",
		gaze: {
			yaw: 6,
			pitch: -14,
			roll: 0
		},
		split: 19.5,
		eyes: M(.4, .56, -10)
	},
	{
		id: "heureux",
		gaze: {
			yaw: 5,
			pitch: 9,
			roll: 0
		},
		split: 17,
		eyes: M(.27, .17, 14)
	},
	{
		id: "hilare",
		gaze: {
			yaw: 4,
			pitch: 14,
			roll: 0
		},
		split: 18,
		eyes: M(.34, .13, 20)
	},
	{
		id: "colere",
		gaze: {
			yaw: 3,
			pitch: 7,
			roll: 0
		},
		split: 17,
		eyes: M(.34, .15, 30)
	},
	{
		id: "triste",
		gaze: {
			yaw: 3,
			pitch: -13,
			roll: 0
		},
		split: 16,
		eyes: M(.22, .4, -28)
	},
	{
		id: "effraye",
		gaze: {
			yaw: 2,
			pitch: -20,
			roll: 0
		},
		split: 20.5,
		eyes: M(.4, .6)
	},
	{
		id: "mefiant",
		gaze: {
			yaw: 12,
			pitch: 6,
			roll: -6
		},
		split: 16,
		eyes: [j(.21, .4), j(.22, .15)]
	},
	{
		id: "confus",
		gaze: {
			yaw: -14,
			pitch: 3,
			roll: 8
		},
		split: 16.5,
		eyes: [j(.2, .44, -18), j(.28, .17, 14)]
	},
	{
		id: "curieux",
		gaze: {
			yaw: 16,
			pitch: -9,
			roll: -15
		},
		split: 16.5,
		eyes: [j(.24, .46, -8), j(.2, .38, -8)]
	},
	{
		id: "fier",
		gaze: {
			yaw: 5,
			pitch: 17,
			roll: 0
		},
		split: 17,
		eyes: M(.3, .15, 18)
	},
	{
		id: "timide",
		gaze: {
			yaw: -19,
			pitch: -14,
			roll: -7
		},
		split: 14,
		eyes: M(.17, .3)
	},
	{
		id: "blase",
		gaze: {
			yaw: -22,
			pitch: 2,
			roll: 0
		},
		split: 16,
		eyes: M(.3, .12)
	},
	{
		id: "somnolent",
		gaze: {
			yaw: 6,
			pitch: -9,
			roll: -3
		},
		split: 16,
		eyes: M(.2, .42, 0, .42)
	}
], N = new Map(se.map((e) => [e.id, e])), ce = (e, t, r) => ({
	w: n(e.w, t.w, r),
	h: n(e.h, t.h, r),
	tilt: n(e.tilt ?? 0, t.tilt ?? 0, r),
	open: n(e.open, t.open, r)
});
function le(e, t, r) {
	return {
		id: t.id,
		gaze: {
			yaw: n(e.gaze.yaw, t.gaze.yaw, r),
			pitch: n(e.gaze.pitch, t.gaze.pitch, r),
			roll: n(e.gaze.roll, t.gaze.roll, r)
		},
		split: n(e.split, t.split, r),
		eyes: [ce(e.eyes[0], t.eyes[0], r), ce(e.eyes[1], t.eyes[1], r)]
	};
}
// web/avatar-showcase/src/bot/profiles.ts
var ue = {
	egg: [
		.8369,
		.8424,
		.8497,
		.8585,
		.8674,
		.8775,
		.8878,
		.8983,
		.9089,
		.9185,
		.9288,
		.9374,
		.9445,
		.9504,
		.9543,
		.9559,
		.9555,
		.9519,
		.9466,
		.9389,
		.9302,
		.9193,
		.9085,
		.8969,
		.8852,
		.8734,
		.8625,
		.8513,
		.8411,
		.8325,
		.8243,
		.8179,
		.8137,
		.8112,
		.8102,
		.8128,
		.8178,
		.8262,
		.8374,
		.8518,
		.8702,
		.8922,
		.9169,
		.9446,
		.9741,
		1.0023,
		1.0267,
		1.0433,
		1.0481,
		1.0393,
		1.0216,
		.997,
		.9697,
		.9418,
		.9169,
		.8949,
		.876,
		.8604,
		.849,
		.8394,
		.8337,
		.8314,
		.8305,
		.8326
	],
	hexagon: [
		.921,
		.9282,
		.9441,
		.9706,
		.9984,
		1.0059,
		.9896,
		.9562,
		.929,
		.9124,
		.9047,
		.9058,
		.9157,
		.9349,
		.9642,
		.9873,
		.9882,
		.9665,
		.9336,
		.9105,
		.8968,
		.8918,
		.8955,
		.908,
		.9293,
		.9611,
		.982,
		.9812,
		.959,
		.9282,
		.9089,
		.8978,
		.8964,
		.9026,
		.9189,
		.9439,
		.9778,
		.999,
		.9964,
		.9713,
		.9439,
		.9274,
		.9196,
		.9206,
		.9308,
		.9502,
		.9799,
		1.0121,
		1.0226,
		1.0071,
		.9752,
		.951,
		.9366,
		.9316,
		.9351,
		.9485,
		.9711,
		1.0026,
		1.0213,
		1.0155,
		.9863,
		.9547,
		.9347,
		.9232
	],
	triangle: [
		.7819,
		.8211,
		.8747,
		.944,
		1.0223,
		1.096,
		1.1401,
		1.134,
		1.0808,
		1.0047,
		.9265,
		.8603,
		.8104,
		.773,
		.745,
		.7273,
		.7151,
		.7118,
		.7148,
		.7245,
		.7427,
		.768,
		.8037,
		.8518,
		.9148,
		.9876,
		1.0583,
		1.1073,
		1.1109,
		1.0667,
		.994,
		.9164,
		.8482,
		.7948,
		.7555,
		.7261,
		.7056,
		.6925,
		.6859,
		.6869,
		.6938,
		.7084,
		.7305,
		.7615,
		.804,
		.8595,
		.9311,
		1.0092,
		1.0791,
		1.1171,
		1.1054,
		1.0501,
		.9779,
		.905,
		.845,
		.799,
		.7656,
		.7413,
		.7258,
		.716,
		.7146,
		.7204,
		.733,
		.7528
	]
}, P = Array.from({ length: 64 }, (t, n) => n / 64 * e), F = P.map(Math.cos), I = P.map(Math.sin);
function L(e, t = {}) {
	return {
		radii: [...ue[e]],
		rot: 0,
		cx: 0,
		cy: 0,
		sx: 1,
		sy: 1,
		...t
	};
}
function R(e, t = {}) {
	return {
		radii: Array(64).fill(e),
		rot: 0,
		cx: 0,
		cy: 0,
		sx: 1,
		sy: 1,
		...t
	};
}
function de(t, r, i, a) {
	let o = a ?? {
		radii: Array(64),
		rot: 0,
		cx: 0,
		cy: 0,
		sx: 1,
		sy: 1
	};
	for (let e = 0; e < 64; e++) o.radii[e] = n(t.radii[e] ?? 1, r.radii[e] ?? 1, i);
	let s = r.rot - t.rot;
	for (; s > Math.PI;) s -= e;
	for (; s < -Math.PI;) s += e;
	return o.rot = t.rot + s * i, o.cx = n(t.cx, r.cx, i), o.cy = n(t.cy, r.cy, i), o.sx = n(t.sx, r.sx, i), o.sy = n(t.sy, r.sy, i), o;
}
function z(e, t, n = []) {
	let r = Math.cos(e.rot), i = Math.sin(e.rot);
	for (let a = 0; a < 64; a++) {
		let o = e.radii[a] ?? 1, s = o * (F[a] ?? 0), c = o * (I[a] ?? 0), l = s * r - c * i, u = s * i + c * r, d = n[a] ?? {
			x: 0,
			y: 0
		};
		d.x = (l * e.sx + e.cx) * t, d.y = (u * e.sy + e.cy) * t, n[a] = d;
	}
	return n.length = 64, n;
}
function fe(e, t = 1 / 6) {
	let n = e.length;
	if (n < 3) return "";
	let r = e[0], i = `M${o(r.x)} ${o(r.y)}`;
	for (let r = 0; r < n; r++) {
		let a = e[(r - 1 + n) % n], s = e[r], c = e[(r + 1) % n], l = e[(r + 2) % n], u = s.x + (c.x - a.x) * t, d = s.y + (c.y - a.y) * t, f = c.x - (l.x - s.x) * t, p = c.y - (l.y - s.y) * t;
		i += `C${o(u)} ${o(d)} ${o(f)} ${o(p)} ${o(c.x)} ${o(c.y)}`;
	}
	return `${i}Z`;
}
function B(e, t, n) {
	let r = Array(64).fill(0), i = e.length;
	for (let a = 0; a < 64; a++) {
		let o = F[a] ?? 0, s = I[a] ?? 0, c = 0;
		for (let r = 0; r < i; r++) {
			let a = e[r], l = e[(r + 1) % i], u = l.x - a.x, d = l.y - a.y, f = o * d - s * u;
			if (Math.abs(f) < 1e-9) continue;
			let p = a.x - t, m = a.y - n, h = (p * d - m * u) / f, g = (p * s - m * o) / f;
			h > c && g >= 0 && g <= 1 && (c = h);
		}
		r[a] = c;
	}
	return r;
}
function V(t, n, r, i, a, o, s = 96) {
	let c = i - t, l = a - n, u = Math.hypot(c, l) || 1e-6, d = Math.atan2(l, c), f = Math.acos(Math.max(-1, Math.min(1, (r - o) / u))), p = [];
	for (let i = 0; i <= s / 2; i++) {
		let a = d + f + (e - 2 * f) * i / (s / 2);
		p.push({
			x: t + Math.cos(a) * r,
			y: n + Math.sin(a) * r
		});
	}
	for (let e = 0; e <= s / 2; e++) {
		let t = d - f + 2 * f * e / (s / 2);
		p.push({
			x: i + Math.cos(t) * o,
			y: a + Math.sin(t) * o
		});
	}
	return p;
}
function pe(t, r) {
	let i = t.length, a = (r / e % 1 + 1) % 1 * i, o = Math.floor(a);
	return n(t[o % i] ?? 1, t[(o + 1) % i] ?? 1, a - o);
}
function me(e, t = 1, n = 1) {
	return P.map((r, i) => (Math.abs((F[i] ?? 0) / t) ** e + Math.abs((I[i] ?? 0) / n) ** e) ** (-1 / e));
}
function he(e) {
	let t = Array(64).fill(0);
	for (let n = 0; n < 64; n++) {
		let r = F[n] ?? 0, i = I[n] ?? 0, a = 0;
		for (let t of e) {
			let e = r * t.x + i * t.y, n = e * e - (t.x * t.x + t.y * t.y - t.r * t.r);
			if (n < 0) continue;
			let o = e + Math.sqrt(n);
			o > a && (a = o);
		}
		t[n] = a;
	}
	return t;
}
function ge(t, n, r = 10) {
	let i = t.length, a = [], o = (e, t) => {
		let n = t.x - e.x, r = t.y - e.y, i = Math.hypot(n, r) || 1;
		return Math.atan2(-n / i, r / i);
	};
	for (let s = 0; s < i; s++) {
		let c = t[(s - 1 + i) % i], l = t[s], u = t[(s + 1) % i], d = o(c, l), f = o(l, u) - d;
		for (; f > Math.PI;) f -= e;
		for (; f < -Math.PI;) f += e;
		for (let e = 0; e <= r; e++) {
			let t = d + f * e / r;
			a.push({
				x: l.x + Math.cos(t) * n,
				y: l.y + Math.sin(t) * n
			});
		}
	}
	return a;
}
function _e(t, n, r, i = 0) {
	let a = i * Math.PI / 180;
	return B(ge(Array.from({ length: t }, (i, o) => {
		let s = a + o / t * e;
		return {
			x: Math.cos(s) * (n - r),
			y: Math.sin(s) * (n - r)
		};
	}), r), 0, 0);
}
function ve(e, t = 1) {
	if (e.length < 3) return "";
	let n = "";
	for (let r = 0; r < e.length; r++) {
		let i = e[r];
		n += `${r === 0 ? "M" : "L"}${o(i.x * t)} ${o(i.y * t)}`;
	}
	return `${n}Z`;
}
function ye(e, t) {
	let n = Math.max(e, .01) / 2, r = Math.max(t, .01) / 2, i = Math.min(n, r);
	return `M${o(-n)} ${o(-r + i)}A${o(i)} ${o(i)} 0 0 1 ${o(-n + i)} ${o(-r)}L${o(n - i)} ${o(-r)}A${o(i)} ${o(i)} 0 0 1 ${o(n)} ${o(-r + i)}L${o(n)} ${o(r - i)}A${o(i)} ${o(i)} 0 0 1 ${o(n - i)} ${o(r)}L${o(-n + i)} ${o(r)}A${o(i)} ${o(i)} 0 0 1 ${o(-n)} ${o(r - i)}Z`;
}
// web/avatar-showcase/src/bot/skins.ts
function H(e, t = 1) {
	let n = Math.max(...e);
	if (n <= 0) return e;
	let r = t / n;
	return e.map((e) => e * r);
}
var be = H(Array.from({ length: 64 }, (e, t) => t / 64 * Math.PI * 2).map((e) => 1 + .075 * Math.cos(2 * e + .5) + .035 * Math.cos(3 * e + 2.1)), 1.02), xe = H(he([
	{
		x: -.44,
		y: .2,
		r: .54
	},
	{
		x: .46,
		y: .2,
		r: .5
	},
	{
		x: .02,
		y: .3,
		r: .6
	},
	{
		x: -.24,
		y: -.3,
		r: .48
	},
	{
		x: .3,
		y: -.24,
		r: .44
	}
]), 1.02), Se = H(B(V(0, .28, .66, 0, -.96, .05), 0, 0), 1.04), Ce = B(V(-.42, 0, .62, .42, 0, .62), 0, 0), we = [
	{
		id: "cercle",
		radii: Array(64).fill(1)
	},
	{
		id: "galet",
		radii: be
	},
	{
		id: "squircle",
		radii: H(me(4.2), 1.15)
	},
	{
		id: "capsule",
		radii: Ce
	},
	{
		id: "triangle",
		radii: _e(3, 1.12, .34, -90)
	},
	{
		id: "hexagone",
		radii: _e(6, 1.04, .26, 0)
	},
	{
		id: "nuage",
		radii: xe
	},
	{
		id: "goutte",
		radii: Se
	}
], U = new Map(we.map((e) => [e.id, e]));
new Map([
	{
		id: "encre",
		hex: "#4D5C69"
	},
	{
		id: "brun",
		hex: "#927057"
	},
	{
		id: "rouge",
		hex: "#B2634F"
	},
	{
		id: "orange",
		hex: "#BC8053"
	},
	{
		id: "ambre",
		hex: "#A87932"
	},
	{
		id: "vert",
		hex: "#7D824B"
	},
	{
		id: "turquoise",
		hex: "#648468"
	},
	{
		id: "bleu",
		hex: "#597C91"
	},
	{
		id: "violet",
		hex: "#867399"
	},
	{
		id: "rose",
		hex: "#AF7286"
	},
	{
		id: "gris",
		hex: "#898B80"
	},
	{
		id: "creme",
		hex: "#DED1B2"
	}
].map((e) => [e.id, e]));
// web/avatar-showcase/src/bot/states.ts
var W = (e, t) => [{
	w: e,
	h: t,
	open: 1
}, {
	w: e,
	h: t,
	open: 1
}];
function G(e = {}) {
	return {
		sil: R(1),
		offX: 0,
		offY: 0,
		gaze: { ...D },
		split: w,
		eyes: W(T, E),
		eyeAlpha: 1,
		bodyAlpha: 1,
		dots: [],
		arcs: [],
		notif: null,
		dotsBehind: !1,
		...e
	};
}
var Te = -.1875, Ee = B(V(0, -.505, .132, 0, .13, .075), 0, Te), De = B(V(0, -.2535, .1345, 0, .2535, .1345), 0, 0), Oe = (e = {}) => ({
	radii: [...Ee],
	rot: 0,
	cx: 0,
	cy: Te,
	sx: 1,
	sy: 1,
	...e
}), ke = (e = {}) => ({
	radii: [...De],
	rot: 0,
	cx: 0,
	cy: 0,
	sx: 1,
	sy: 1,
	...e
}), Ae = ve(V(0, 0, .118, 0, .172, .012)), je = .213;
function Me(e) {
	return L("triangle", {
		rot: e,
		cx: -.213 * Math.sin(e),
		cy: je * Math.cos(e)
	});
}
function Ne(n, r) {
	let i = ((n - r * .5) / 1.5 % 1 + 1) % 1;
	return t((i < .5 ? .5 - .5 * Math.cos(i * e) : 0) * 2);
}
var Pe = [
	{
		id: "idle",
		duration: 2.4,
		morph: .45,
		blinkIn: !1,
		baseFace: !0,
		baseBody: !0,
		pose: () => G()
	},
	{
		id: "thinking",
		duration: 2.6,
		morph: .4,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !0,
		pose: (e) => {
			let n = Ne(e, 1), i = .3 + .7 * r.easeOutCubic(t(e / .3));
			return G({
				sil: R(p * (1 + (m - 1) * n), { cx: f[1] }),
				eyeAlpha: 0,
				dots: [0, 2].map((t) => {
					let n = Ne(e, t);
					return {
						x: f[t] * i,
						y: 0,
						r: p * (1 + (m - 1) * n),
						opacity: .55 + .45 * n
					};
				})
			});
		}
	},
	{
		id: "wink",
		duration: 1.6,
		morph: .3,
		blinkIn: !0,
		baseFace: !1,
		baseBody: !0,
		pose: () => G({
			gaze: {
				yaw: -5.37,
				pitch: 4.55,
				roll: 6.7
			},
			split: 16.25,
			eyes: [{
				w: .236,
				h: .464,
				open: 1
			}, {
				w: .447,
				h: .089,
				open: 1
			}]
		})
	},
	{
		id: "wide",
		duration: 1.8,
		morph: .55,
		blinkIn: !0,
		baseFace: !1,
		baseBody: !0,
		pose: () => G({
			gaze: {
				yaw: 6.92,
				pitch: -21.96,
				roll: 11.6
			},
			split: 18.43,
			eyes: W(.356, .875)
		})
	},
	{
		id: "alert",
		duration: 2.4,
		minDuration: 2,
		morph: .45,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !1,
		pose: (n) => {
			let i = t(n / 1.5), a = r.easeInOutCubic(i) * .82 - .087, o = n > 1.6 ? t((n - 1.6) / .4) : 0, s = a * (1 - o) + .1 * o, c = Math.sin(n * 2.5 * e) * .005, l = 17.7 * Math.PI / 180;
			return G({
				sil: ke({
					rot: l,
					cx: s,
					cy: -.325 - c
				}),
				eyeAlpha: 0,
				dots: [{
					x: s - Math.sin(l) * .58,
					y: -.325 + Math.cos(l) * .58 + c * 2.8,
					r: .118,
					d: Ae,
					rot: l * 180 / Math.PI,
					opacity: 1
				}]
			});
		}
	},
	{
		id: "notify",
		duration: 2.2,
		morph: .5,
		blinkIn: !0,
		baseFace: !1,
		baseBody: !0,
		pose: (e) => {
			let n = t(e / .45), r = 1 + (ee - 1) * Math.sin(n * Math.PI) * (1 - n * .35), i = S * (n < 1 ? r : 1), a = -42 * Math.PI / 180;
			return G({
				gaze: {
					yaw: -21.94,
					pitch: -5.82,
					roll: -12.2
				},
				split: 18.89,
				eyes: W(.505, .498),
				notif: {
					x: Math.cos(a) * x,
					y: Math.sin(a) * x,
					r: i,
					notch: i + C
				}
			});
		}
	},
	{
		id: "exclaim",
		duration: 2,
		morph: .45,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !1,
		pose: () => G({
			sil: Oe(),
			eyeAlpha: 0,
			dots: [{
				x: -.012,
				y: .526,
				r: .113,
				opacity: 1
			}]
		})
	},
	{
		id: "sleep",
		duration: 2.4,
		morph: .5,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !1,
		pose: (t) => G({
			sil: R(.1585, { cy: .11 + Math.sin(e / .6 * t) * .19 }),
			eyeAlpha: 0
		})
	},
	{
		id: "egg",
		duration: 1.8,
		morph: .4,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !0,
		pose: () => G({
			sil: L("egg"),
			gaze: {
				yaw: 19.97,
				pitch: 26.01,
				roll: -17.1
			},
			split: 11.07,
			eyes: W(.164, .385)
		})
	},
	{
		id: "hexagon",
		duration: 1.6,
		morph: .4,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !0,
		pose: () => G({
			sil: L("hexagon"),
			gaze: {
				yaw: 23.11,
				pitch: 24.42,
				roll: -13.3
			},
			split: 13.37,
			eyes: W(.177, .411)
		})
	},
	{
		id: "play",
		duration: 2,
		morph: .5,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !0,
		pose: (e) => {
			let n = t(e / .35) * t((2.2 - e) / .5);
			return G({
				sil: Me(0),
				gaze: {
					yaw: 12,
					pitch: -8,
					roll: -6
				},
				split: 15,
				eyes: W(.18, .34),
				arcs: d.map((t, r) => ({
					id: `sw${r}`,
					seed: {
						...t,
						cx: .45 - e * .42
					},
					t: e,
					opacity: n
				}))
			});
		}
	},
	{
		id: "orbit",
		duration: 3.4,
		minDuration: 2.5,
		morph: .6,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !1,
		pose: (n) => {
			let i = r.easeInOutCubic(t(n / .35)), a = -e * 1.25 * n * i, o = r.easeInOutCubic(t((n - 1.6) / .9)), s = Me(a), c = R(1, { rot: a }), l = {
				radii: s.radii.map((e, t) => e + (c.radii[t] - e) * o),
				rot: a,
				cx: s.cx * (1 - o),
				cy: s.cy * (1 - o),
				sx: 1,
				sy: 1
			}, d = t(n / .8) * t((3.6 - n) / .9);
			return G({
				sil: l,
				gaze: {
					yaw: D.yaw + Math.sin(n * 6.5) * 65 * (1 - o),
					pitch: -4 + o * 32,
					roll: -13
				},
				eyes: W(.18, .34 + o * .07),
				arcs: u.map((e, r) => ({
					id: `rg${r}`,
					seed: e,
					t: n,
					opacity: d * t((n - r * .13) / .3)
				}))
			});
		}
	},
	{
		id: "swirl",
		duration: 1.3,
		minDuration: 1.3,
		morph: .3,
		baseFace: !0,
		baseBody: !0,
		blinkIn: !0,
		pose: (e) => G({ arcs: u.slice(0, 3).map((n, r) => ({
			id: `sw${r}`,
			seed: n,
			t: e,
			opacity: t((e - r * .06) / .14) * t((1.22 - e) / .34)
		})) })
	},
	{
		id: "burst",
		duration: 2.6,
		minDuration: 2.4,
		morph: .4,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !1,
		pose: (e) => {
			let n = 1 - .834 * r.easeOutQuint(t(e / .7)), i = r.easeOutQuint(t((e - 1.7) / .7));
			return G({
				sil: R(n + (1 - n) * i),
				eyeAlpha: t((e - 1.85) / .4),
				dots: _(e, 1),
				dotsBehind: !0
			});
		}
	},
	{
		id: "comet",
		duration: 2.4,
		minDuration: 2.4,
		morph: .45,
		baseFace: !1,
		baseBody: !1,
		blinkIn: !1,
		pose: (e) => {
			let n = 1 - (1 - b) * r.easeOutQuint(t(e / .55)), i = r.easeOutQuint(t((e - 1.85) / .6)), a = t((e - .15) / .25) * t((1.95 - e) / .3);
			return G({
				sil: R(n + (1 - n) * i, { cy: Math.sin(t(e / 1.7) * Math.PI) * .035 }),
				eyeAlpha: t((e - 2) / .35),
				arcs: y.map((t, n) => ({
					id: `cm${n}`,
					seed: t,
					t: e,
					opacity: a
				}))
			});
		}
	}
], K = new Map(Pe.map((e) => [e.id, e])), q = 100, Fe = 7.1, Ie = 5.5, Le = .006, Re = .007;
function ze(e, t, n) {
	let r = [], i = te(e.gaze, q, e.split);
	for (let a = 0; a < 2; a++) {
		let o = i[a];
		if (o.depth <= .02) continue;
		let s = e.eyes[a], c = (s.tilt ?? 0) * Math.PI / 180, l = Math.cos(c), u = Math.sin(c), d = o.a * l + o.c * u, f = o.b * l + o.d * u, p = -o.a * u + o.c * l, m = -o.b * u + o.d * l, h = Math.max(s.w * q, .01) / 2, g = Math.max(s.h * q, .01) / 2, _ = Math.min(h, g), v = g > h, y = v ? g - _ : h - _, b = pe(n, Math.atan2(o.y, o.x) - t.rot);
		r.push({
			x: o.x * b,
			y: o.y * b,
			ax: (v ? p : d) * y,
			ay: (v ? m : f) * y,
			r: _,
			m: [
				d,
				f,
				p,
				m
			]
		});
	}
	return r;
}
function Be(e, t, n, r, i) {
	let a = r - t, o = i - n, s = a * a + o * o, c = Infinity, l = 0, u = 0;
	for (let r = 0; r < e.length; r++) {
		let i = e[r], d = s > 0 ? ((i.x - t) * a + (i.y - n) * o) / s : 0;
		d = d < 0 ? 0 : d > 1 ? 1 : d;
		let f = t + d * a - i.x, p = n + d * o - i.y, m = f * f + p * p;
		m < c && (c = m, l = f, u = p);
	}
	let d = Math.sqrt(c);
	return {
		d,
		ux: d > 1e-9 ? l / d : 0,
		uy: d > 1e-9 ? u / d : 0
	};
}
var Ve = Math.hypot(Le, Re) * q;
function He(e, t, n, r) {
	let i = Infinity, a = 0, o = 0;
	for (let s of t) {
		let t = s.x + n, c = s.y + r, l = Be(e, t - s.ax, c - s.ay, t + s.ax, c + s.ay), [u, d, f, p] = s.m, m = s.r * Math.hypot(u * l.ux + d * l.uy, f * l.ux + p * l.uy) + Ve;
		l.d - m < i && (i = l.d - m, a = l.ux, o = l.uy);
	}
	return {
		marge: i,
		ux: a,
		uy: o
	};
}
var Ue = 12, We = 8;
function Ge(e) {
	if (!e.length) return {
		x: 0,
		y: 0
	};
	let t = (t, n) => {
		let r = Infinity;
		for (let i of e) r = Math.min(r, He(i.contour, i.empreintes, t, n).marge);
		return r;
	}, n = Infinity;
	for (let t of e) n = Math.min(n, He(t.calContour, t.reference, 0, 0).marge);
	let r = 0, i = 0, a = e[0].empreintes;
	for (let e of a) r -= e.x / a.length, i -= e.y / a.length;
	let o = Math.max(.35 * q, Math.hypot(r, i) * 1.25);
	n = Math.min(n, t(r, i));
	let s = t(0, 0);
	if (s >= n && s >= 0) return {
		x: 0,
		y: 0
	};
	let c = Math.max(n, 0), l = 0, u = 0, d = Infinity, f = 0, p = 0, m = s;
	for (let e = 0; e < Ue; e++) {
		let n = e / Ue * Math.PI * 2, r = Math.cos(n), i = Math.sin(n);
		if (t(r * o, i * o) < c) {
			for (let e of [
				.3,
				.6,
				1
			]) {
				let n = t(r * o * e, i * o * e);
				n > m && (m = n, f = r * o * e, p = i * o * e);
			}
			continue;
		}
		let a = 0, s = o;
		for (let e = 0; e < We; e++) {
			let e = (a + s) / 2;
			t(r * e, i * e) >= c ? s = e : a = e;
		}
		s < d && (d = s, l = r * s, u = i * s);
	}
	let h = d === Infinity ? f : l, g = d === Infinity ? p : u;
	return {
		x: +(h / q).toFixed(6),
		y: +(g / q).toFixed(6)
	};
}
function Ke(e, t, n) {
	return e.baseFace && n ? {
		gaze: n.gaze,
		split: n.split,
		eyes: n.eyes
	} : {
		gaze: t.gaze,
		split: t.split,
		eyes: t.eyes
	};
}
function qe(e) {
	let t = (e) => JSON.stringify([
		e.gaze,
		e.split,
		e.eyes,
		e.sil.rot,
		e.sil.cx,
		e.sil.cy,
		e.sil.sx,
		e.sil.sy
	]);
	return t(e.pose(0)) === t(e.pose(e.duration)) ? [0] : Array.from({ length: 3 }, (t, n) => n / 2 * e.duration);
}
function Je(e, t, n) {
	let r = [];
	for (let i of qe(e)) {
		let a = e.pose(i), o = z({
			...a.sil,
			radii: t
		}, q), s = z(a.sil, q), c = Ke(e, a, n), l = [];
		for (let e of [-7.1, Fe]) for (let t of [-5.5, Ie]) l.push({
			...c,
			gaze: {
				yaw: c.gaze.yaw + e,
				pitch: c.gaze.pitch + t,
				roll: c.gaze.roll
			}
		});
		for (let e of l) r.push({
			empreintes: ze(e, a.sil, t),
			reference: ze(e, a.sil, a.sil.radii),
			contour: o,
			calContour: s
		});
	}
	return Ge(r);
}
var J = {
	x: 0,
	y: 0
}, Y = (e, t) => `${e}|${t ?? ""}`;
function Ye() {
	return new Map(we.map((e) => {
		let t = /* @__PURE__ */ new Map();
		for (let n of Pe) {
			if (!n.baseBody) continue;
			let r = n.baseFace ? [null, ...se] : [null];
			for (let i of r) t.set(Y(n.id, i?.id ?? null), Je(n, e.radii, i));
		}
		return [e.radii, t];
	}));
}
var Xe = Ye();
function Ze(e, t, n) {
	if (!e) return J;
	let r = Xe.get(e);
	return r ? r.get(Y(t, n)) ?? r.get(Y(t, null)) ?? J : J;
}
// web/avatar-showcase/src/bot/engine.ts
var Qe = {
	yaw: 0,
	pitch: 0,
	mix: 0,
	spin: 0,
	wander: 1
}, $e = (e, t, r) => ({
	yaw: n(e.yaw, t.yaw, r),
	pitch: n(e.pitch, t.pitch, r),
	mix: n(e.mix, t.mix, r),
	spin: n(e.spin, t.spin, r),
	wander: n(e.wander, t.wander, r)
}), et = (e, t, r) => ({
	w: n(e.w, t.w, r),
	h: n(e.h, t.h, r),
	open: n(e.open, t.open, r),
	tilt: n(e.tilt ?? 0, t.tilt ?? 0, r)
});
function tt(e, t, r) {
	let i = 1 - r;
	return {
		sil: de(e.sil, t.sil, r),
		offX: n(e.offX, t.offX, r),
		offY: n(e.offY, t.offY, r),
		gaze: {
			yaw: n(e.gaze.yaw, t.gaze.yaw, r),
			pitch: n(e.gaze.pitch, t.gaze.pitch, r),
			roll: n(e.gaze.roll, t.gaze.roll, r)
		},
		split: n(e.split, t.split, r),
		eyes: [et(e.eyes[0], t.eyes[0], r), et(e.eyes[1], t.eyes[1], r)],
		eyeAlpha: n(e.eyeAlpha, t.eyeAlpha, r),
		bodyAlpha: n(e.bodyAlpha, t.bodyAlpha, r),
		dots: [...e.dots.map((e) => ({
			...e,
			opacity: e.opacity * i
		})), ...t.dots.map((e) => ({
			...e,
			opacity: e.opacity * r
		}))],
		arcs: [...e.arcs.map((e) => ({
			...e,
			id: `a${e.id}`,
			opacity: e.opacity * i
		})), ...t.arcs.map((e) => ({
			...e,
			id: `b${e.id}`,
			opacity: e.opacity * r
		}))],
		notif: r < .5 ? e.notif : t.notif,
		dotsBehind: r < .5 ? e.dotsBehind : t.dotsBehind
	};
}
var nt = class e {
	scale;
	cur;
	prev = null;
	departFige = null;
	tCur = 0;
	tPrev = 0;
	posePhase = 0;
	previousPosePhase = 0;
	blinkAt = -10;
	pts = [];
	shape = null;
	shapePrev = null;
	shapeAt = -10;
	expr = null;
	exprPrev = null;
	exprAt = -10;
	look = Qe;
	lookPrev = Qe;
	lookAt = -10;
	lookMorph = .24;
	static SHAPE_MORPH = .45;
	static LOOK_MORPH = .24;
	constructor(e = 100, t = "idle", n = null, r = null) {
		this.scale = e, this.cur = t, this.shape = n, this.expr = r;
	}
	setExpression(e, t = 0) {
		e !== this.expr && (this.exprPrev = this.expr, this.expr = e, this.exprAt = t);
	}
	exprAtTime(n) {
		let i = this.expr, a = this.exprPrev;
		if (!i || !a) return i;
		let o = (n - this.exprAt) / e.SHAPE_MORPH;
		return o >= 1 ? i : le(a, i, r.easeOutQuint(t(o)));
	}
	setShape(e, t = 0) {
		e !== this.shape && (this.shapePrev = this.shape, this.shape = e, this.shapeAt = t);
	}
	shapeAtTime(i) {
		let a = this.shape, o = this.shapePrev;
		if (!a || !o) return a;
		let s = (i - this.shapeAt) / e.SHAPE_MORPH;
		if (s >= 1) return a;
		let c = r.easeOutQuint(t(s));
		return a.map((e, t) => n(o[t] ?? e, e, c));
	}
	setLook(t, n, r = e.LOOK_MORPH) {
		(!t || Number.isFinite(t.yaw + t.pitch + t.mix + t.spin + t.wander)) && (this.lookPrev = this.lookAtTime(n), this.look = t ?? Qe, this.lookAt = n, this.lookMorph = r);
	}
	lookAtTime(e) {
		let n = (e - this.lookAt) / this.lookMorph;
		return n >= 1 ? this.look : $e(this.lookPrev, this.look, r.easeOutQuint(t(n)));
	}
	posed(e, t, n, r) {
		let i = e.pose(t);
		return e.baseBody && n && (i = {
			...i,
			sil: {
				...i.sil,
				radii: n
			}
		}), e.baseFace && r && (i = {
			...i,
			gaze: r.gaze,
			split: r.split,
			eyes: r.eyes
		}), i;
	}
	decalageAtTime(i, a) {
		let o = (e, a, o, s) => {
			if (o === s) return s;
			let c = (i - e) / a;
			if (c >= 1) return s;
			let l = r.easeOutQuint(t(c));
			return {
				x: n(o.x, s.x, l),
				y: n(o.y, s.y, l)
			};
		}, s = (t) => o(this.exprAt, e.SHAPE_MORPH, Ze(t, a, this.exprPrev?.id ?? null), Ze(t, a, this.expr?.id ?? null));
		return o(this.shapeAt, e.SHAPE_MORPH, s(this.shapePrev), s(this.shape));
	}
	get state() {
		return this.cur;
	}
	reset(e, t) {
		this.cur = e, this.prev = null, this.departFige = null, this.tCur = t, this.tPrev = t, this.posePhase = 0, this.previousPosePhase = 0, this.blinkAt = -10;
	}
	origine(e, t, n) {
		if (this.departFige) return this.departFige;
		if (!this.prev) return null;
		let r = K.get(this.prev);
		return this.posed(r, Math.max(0, e - this.tPrev + this.previousPosePhase), t, n);
	}
	poseComposee(e) {
		let n = K.get(this.cur), i = this.shapeAtTime(e), a = this.exprAtTime(e), o = this.posed(n, Math.max(0, e - this.tCur + this.posePhase), i, a), s = e - this.tCur;
		if (s >= n.morph) return o;
		let c = this.origine(e, i, a);
		return c ? tt(c, o, r.easeOutQuint(t(s / n.morph))) : o;
	}
	setState(e, t, n = 0) {
		if (e === this.cur) return;
		let r = K.get(this.cur).morph, i = this.prev !== null && t - this.tCur < r;
		this.departFige = i ? this.poseComposee(t) : null, this.prev = this.cur, this.tPrev = this.tCur, this.previousPosePhase = this.posePhase, this.posePhase = n, this.cur = e, this.tCur = t, K.get(e)?.blinkIn && (this.blinkAt = t);
	}
	sample(e) {
		let i = this.scale, a = K.get(this.cur), s = this.shapeAtTime(e), l = this.exprAtTime(e), u = this.posed(a, Math.max(0, e - this.tCur + this.posePhase), s, l), d = this.decalageAtTime(e, this.cur), f = e - this.tCur, p = f < a.morph ? this.origine(e, s, l) : null;
		if (p) {
			let i = r.easeOutQuint(t(f / a.morph));
			u = tt(p, u, i);
			let o = this.prev;
			if (o) {
				let t = this.decalageAtTime(e, o);
				d = {
					x: n(t.x, d.x, i),
					y: n(t.y, d.y, i)
				};
			}
		}
		let m = u.eyeAlpha > .01, h = this.lookAtTime(e), g = ae(e, {
			wander: m ? h.wander : 0,
			blink: m
		}), _ = {
			yaw: n(u.gaze.yaw, h.yaw, h.mix) + g.dYaw - h.spin,
			pitch: n(u.gaze.pitch, h.pitch, h.mix) + g.dPitch,
			roll: u.gaze.roll + g.dRoll
		}, v = t((e - this.blinkAt) / .2), y = v < 1 ? Math.abs(v * 2 - 1) : 1, b = Math.min(g.lid, y), x = u.offX + g.driftX, S = u.offY + g.driftY, ee = fe(z({
			...u.sil,
			cx: u.sil.cx + x,
			cy: u.sil.cy + S,
			sy: u.sil.sy * g.breath
		}, i, this.pts)), C = (e, t) => pe(u.sil.radii, Math.atan2(t, e) - u.sil.rot), w = [];
		if (u.eyeAlpha > .01) {
			let e = te(_, i, u.split);
			for (let n = 0; n < 2; n++) {
				let r = e[n];
				if (r.depth <= .02) continue;
				let a = u.eyes[n], s = C(r.x, r.y), c = (a.tilt ?? 0) * Math.PI / 180, l = Math.cos(c), f = Math.sin(c), p = r.a * l + r.c * f, m = r.b * l + r.d * f, h = -r.a * f + r.c * l, g = -r.b * f + r.d * l, _ = oe(Math.min(b, a.open));
				w.push({
					d: ye(a.w * i, a.h * i),
					matrix: `matrix(${o(p)},${o(m * _)},${o(h)},${o(g * _)},${o(r.x * s + (x + d.x) * i)},${o(r.y * s + (S + d.y) * i)})`,
					alpha: u.eyeAlpha * t(r.depth / .12)
				});
			}
		}
		let T = u.dots.filter((e) => e.opacity > .01 && e.r > 5e-4).map((e) => ({
			...e,
			x: (e.x + x) * i,
			y: (e.y + S) * i,
			r: e.r * i
		})), E = u.notif ? C(u.notif.x, u.notif.y) : 1, D = u.notif ? (u.notif.x * E + x) * i : 0, O = u.notif ? (u.notif.y * E + S) * i : 0, k = u.notif ? {
			x: D,
			y: O,
			r: u.notif.r * i
		} : null, A = u.notif ? {
			x: D,
			y: O,
			r: u.notif.notch * i
		} : null;
		return {
			bodyPath: ee,
			bodyAlpha: u.bodyAlpha,
			eyes: w,
			dots: T,
			dotsBehind: u.dotsBehind,
			arcs: u.arcs.filter((e) => e.opacity > .01).map((e) => c(e.seed, e.t, i, e.id, e.opacity)),
			notif: k,
			notch: A
		};
	}
}, X = [
	["cercle", "圆形"],
	["galet", "卵石"],
	["squircle", "圆角方形"],
	["capsule", "胶囊"],
	["triangle", "三角形"],
	["hexagone", "六边形"],
	["nuage", "云朵"],
	["goutte", "水滴"]
].map(([e, t]) => ({
	id: e,
	label: t
})), rt = [
	[
		"olive",
		"橄榄绿",
		"#7D824B"
	],
	[
		"sage",
		"鼠尾草",
		"#648468"
	],
	[
		"clay",
		"陶土红",
		"#B2634F"
	],
	[
		"apricot",
		"杏褐色",
		"#BC8053"
	],
	[
		"ochre",
		"赭石黄",
		"#A87932"
	],
	[
		"mist",
		"雾蓝",
		"#597C91"
	],
	[
		"violet",
		"灰紫",
		"#867399"
	],
	[
		"rose",
		"豆沙粉",
		"#AF7286"
	],
	[
		"graphite",
		"石墨蓝",
		"#4D5C69"
	],
	[
		"kraft",
		"牛皮棕",
		"#927057"
	],
	[
		"stone",
		"暖石灰",
		"#898B80"
	],
	[
		"natural",
		"原色纸",
		"#DED1B2"
	]
].map(([e, t, n]) => ({
	id: e,
	name: t,
	color: n,
	secondary: "#E6DDC8",
	ink: "#414A3C",
	paper: "#FFFBF0"
})), it = {
	dev: "squircle",
	art: "galet",
	music: "goutte",
	plan: "hexagone",
	qa: "nuage",
	write: "triangle",
	ops: "hexagone",
	research: "goutte",
	data: "capsule",
	lead: "cercle",
	translate: "capsule",
	knowledge: "galet",
	circle: "cercle",
	cloud: "nuage",
	square: "squircle",
	star4: "hexagone",
	clover: "galet",
	heart: "cercle",
	flower: "nuage",
	drop: "goutte",
	pill: "capsule",
	pentagon: "galet",
	star6: "capsule",
	hexagon: "hexagone"
}, at = {
	"#FF6A0B": "#BC8053",
	"#FF5B59": "#B2634F",
	"#BB52C9": "#867399",
	"#E7A728": "#A87932",
	"#6A48D8": "#867399",
	"#487BE5": "#597C91",
	"#547697": "#4D5C69",
	"#1478FA": "#597C91",
	"#EC9B29": "#BC8053",
	"#009C9C": "#648468",
	"#8058DD": "#867399",
	"#479C76": "#648468",
	"#31A86C": "#648468",
	"#E95883": "#AF7286",
	"#F47B3D": "#BC8053",
	"#1795AE": "#597C91",
	"#5B7377": "#4D5C69",
	"#FFC18E": "#BC8053",
	"#FF9C9C": "#B2634F",
	"#C5AFF1": "#867399",
	"#FFE39A": "#A87932",
	"#AFDCB7": "#648468",
	"#B6C9FF": "#597C91",
	"#A6B9D6": "#4D5C69",
	"#81D4CF": "#648468",
	"#FFC395": "#BC8053",
	"#FFAAAA": "#B2634F",
	"#B9BCFF": "#867399",
	"#BFDCA9": "#7D824B"
}, Z = (e, t) => typeof e == "string" && /^#[\da-f]{6}$/i.test(e) ? e.toUpperCase() : t;
function Q(e) {
	return X.some((t) => t.id === e) ? e : it[e] || "cercle";
}
function ot(e = {}) {
	let t = !!it[e.shape], n = Z(e.color, "#7D824B"), r = t && at[n] || n, i = [
		"#142443",
		"#FFFFFF",
		"#FFFAF1"
	], a = t ? "#E6DDC8" : Z(e.secondary, "#E6DDC8"), o = Z(e.ink, "#414A3C"), s = Z(e.paper, "#FFFBF0"), c = typeof e.image == "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(e.image) ? e.image : null;
	return {
		shape: Q(e.shape),
		color: r,
		secondary: a,
		ink: t && i.includes(o) ? "#414A3C" : o,
		paper: t && i.includes(s) ? "#FFFBF0" : s,
		image: c
	};
}
function st(e, t = 0) {
	let n = {
		"bot-engineer": ["squircle", 5],
		"bot-components": ["hexagone", 0],
		"bot-qa": ["nuage", 6],
		lumi: ["cercle", 0],
		"bot-lumi": ["cercle", 0],
		"bot-entry": ["cercle", 0],
		"bot-chatroom": ["capsule", 1],
		"bot-manager": ["hexagone", 8],
		"bot-memory": ["galet", 1]
	}, r = 5381;
	for (let n of String(e || `bot-${t}`)) r = (Math.imul(r, 33) ^ n.codePointAt(0)) >>> 0;
	let [i, a] = n[e] || [X[r % X.length].id, r % rt.length];
	return ot({
		shape: i,
		...rt[a],
		image: null
	});
}
// web/avatar-showcase/src/relay/rig.ts
var $ = {
	idle: {
		duration: 6.4,
		expression: "neutre",
		pose: "idle"
	},
	think: {
		duration: 6.4,
		expression: "attentif",
		pose: "idle"
	},
	work: {
		duration: 4.3,
		expression: "attentif",
		pose: "idle"
	},
	done: {
		duration: 2.8,
		expression: "heureux",
		pose: "wink"
	},
	wait: {
		duration: 6.4,
		expression: "curieux",
		pose: "idle"
	},
	confused: {
		duration: 6.4,
		expression: "confus",
		pose: "idle"
	},
	failed: {
		duration: 6.4,
		expression: "triste",
		pose: "idle"
	},
	asleep: {
		duration: 6.4,
		expression: "somnolent",
		pose: "idle"
	}
};
for (let e of N.keys()) $["expression:" + e] = {
	duration: 6.4,
	expression: e,
	pose: "idle"
};
var ct = class {
	engine;
	orbit = new nt(100, "orbit");
	motion = "idle";
	changed = 0;
	finished = !1;
	constructor(e, t = "idle") {
		let n = $[t] || $.idle;
		this.motion = $[t] ? t : "idle", this.engine = new nt(100, n.pose, U.get(Q(e)).radii, N.get(n.expression));
	}
	setShape(e, t) {
		this.engine.setShape(U.get(Q(e)).radii, t);
	}
	setMotion(e, t) {
		let n = $[e] ? e : "idle";
		if (n === this.motion) return;
		this.motion = n, this.changed = t, this.finished = !1;
		let r = $[n];
		this.engine.setState(r.pose, t), this.engine.setExpression(N.get(r.expression), t);
	}
	sample(e) {
		this.motion === "done" && !this.finished && e - this.changed >= 1.6 && (this.finished = !0, this.engine.setState("idle", e));
		let t = this.engine.sample(e);
		return this.motion === "work" && (t.arcs = this.orbit.sample((e - this.changed) % 4.3).arcs), t;
	}
};
export { nt as BotEngine, ct as PaperRig, U as SHAPE_BY_ID, st as defaultPaperAvatar, $ as motions, ot as normalizePaperAvatar, at as paperLegacyColors, it as paperLegacyShapes, X as paperShapes, rt as paperTemplates };
