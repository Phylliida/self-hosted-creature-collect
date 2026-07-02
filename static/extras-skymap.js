// Extras -> Sky Map: a live all-sky planetarium chart.
//
// Renders the whole sky dome for the map location and any moment in time --
// stars to magnitude 5.0, constellation stick figures and labels, the Moon
// (with its real phase), the naked-eye planets, the Sun and the ecliptic --
// on a stereographic "hold it over your head" projection (north up, east
// LEFT, like every printed planisphere). The sky background tints through
// twilight and the stars fade in as the sun drops, so scrubbing the time
// slider around sunset does the right thing.
//
// Plugs into the Extras launcher via global.ExtrasRegisterTool({ ..., build })
// exactly like extras-almanac.js, and reuses that file's Meeus engine
// (global.Almanac) for the Sun/Moon/planet positions. Star math (sidereal
// time + equatorial->horizontal) is duplicated locally in a tiny CORE section
// so the chart's own geometry is unit-testable headless under Node.
//
// STAR DATA is bundled below -- no network, ever, in keeping with the
// zero-data design. It was derived offline from d3-celestial's data files
// (github.com/ofrohn/d3-celestial, BSD-3-Clause; ultimately the Hipparcos
// catalogue): 1627 stars to mag 5.0, proper names for the bright ones, the
// 88 constellations' line figures and label anchors. Positions are J2000
// rounded to 0.05 degrees; precession to the mid-2020s is under 0.4 degrees,
// well below a pixel at this chart scale.
//
// NOTE: the CSS below lives inside a template literal -- never put a
// backtick inside it (even in a comment), it terminates the string and
// breaks the whole file.

(function (global) {
  'use strict';

  const SCRIPT_VERSION = 'auto';  // server stamps with mtime on serve (if tracked)
  if (global._scriptVersions) global._scriptVersions['extras-skymap.js'] = SCRIPT_VERSION;

  // ════════════════════════════════════════════════════════════════════
  // DATA  (generated from d3-celestial's stars.6/starnames/constellations
  // files -- see the provenance note in the header. Base-36 fixed width,
  // 0.05 degree resolution.)
  // ════════════════════════════════════════════════════════════════════
  // 1627 stars to mag 5.0, brightest first (8 chars each: ra*20 / (dec+90)*20 / (mag+2)*10, base36).
  const STAR_DATA = '1ka14q061hc0kq0e3au1oo0k3e60g70k4b51zk0k17z23k0l17p19g0m1rt1gw0o0dl0i70o1dc1i40o3970gh0q4le1ix0s2vp0'
    + 'ey0s12c1n60t33u17t0u3tf0zb0v1sn1tl0w5bc0xk0w2yn0gu0w4sf2360w3e60g70y2ci1kn0y1m50xx0z1r51vq102wc0ia10'
    + '42c0te101961hj1019b1tw1024u0ba111ap1dc1154h0nx111bc1cx111w00np122zi293120se25p1249d0uw122k72cb121ni0'
    + 'zc1236y25e121xt0gy1342v0q4131dy22z133w30bn131j91n41320w0jm134q80ih130l32rl141h51411426u197140ho1r114'
    + '2e41p114062140144do0ze1439l0tt150161u61509p1xs151cb18n153fq2j7155990ny1542j1kz150q520r150h721j152qh1'
    + 'm31507w2bq162xs0mt161v60rs1625d0h2163lt1su162440pv1633o28j164pr20d1605n29f1645j26m161a41du1601a2av17'
    + '35v0kb173pe11g173wb0uy173ei0no173dm0ql172jx29c173ex1t1185151ji1843k0sb1803n0qi182r527u183z415a185c71'
    + 'tm181po0xq184xl2cs182630jg194t31wv195cc1mg190pb1ga193ui185193820nq1a2ln1pe1a3q31301a1a81441a2t60lu1a'
    + '2u71491a4ep0xe1a3jd18s1a3n51hl1a0fx1pk1a1b60v31a1dz1yo1a2ws1101a0bx2bh1b37x1o81b3gt0q11b1591wf1b2hu0'
    + 'mk1b2x60bl1b41y0ta1b1oq0te1b48x0xf1b4kr1jw1b3rc1by1b3so2c61b2hb0e81b2xs1d71b1al1aq1c3370tm1c3fq1531c'
    + '43p1gj1c16r1b61c3tj1py1c3zp1m01c2u40hd1c41w2721c3lw0r51c19l12h1c3v21vk1c03l0731c3ub0yc1c49w0zw1c01u1'
    + 'mg1c1vq10i1c3oo0er1c0wj1vq1c4160j51c4230ma1c0vl1re1c30n1k31c51j1511c0gi0ft1d4kl2331d1h71qi1d3jn0bu1d'
    + '55x0gj1d0or0rm1d4fp12c1d1q41im1d2zs1za1d3p60zi1d0x12081d3sa0zs1d4ze1ax1d0po27q1d29k0dv1d59b1us1d1ky0'
    + 'lw1d2w514u1d5451du1e0x216i1e1aw1pr1e29d1r71e46t0x41e32z1151e44a0rp1e4f31lp1e0i01xg1e2l022q1e3jw2hx1e'
    + '3wj0sv1e52i0t91e0uz24k1e1gu0xb1e1mr10r1e2tf11g1e15y22c1e2yf0c61e3d41za1e4im1tj1e4pl15s1e1k41rz1f2eg2'
    + '121f4g32fl1f48g0tl1f22d1hb1f2i81501f2on0f01f4rw0nq1f1cr0u51f22w24p1f3xh0iw1f3zr1rt1f3gw0qm1f25x1x41f'
    + '27c0ib1g3zr1yg1g1j90q01g27k26q1g3yw2ei1g4cc0z01g16l20x1g3el0dw1g1491hv1g16f11l1g3xc1j81g44l0tf1g4wt1'
    + 'ut1g5h52l51g3jz0rf1g3rw1be1g48z1ce1g4yz2h71g1kp0fl1g4o91dk1g1qe0py1g39k0z61g3hk0zy1g4e71w61g0vk08r1h'
    + '05h1v51h40q1041h5ax1581h17h1501h2d90b31h3kh2ar1h1220jf1h2fs0fq1h1g21qi1h4170io1h0960o21h0pq1zl1h2u52'
    + '9p1h3zd0pz1h45v18l1h4fb0yn1h0zc0fb1h2ln1ml1h1t61071h0fw2dd1i1921co1i1ka1l61i1yv2bq1i4hv1fq1i3k50p61i'
    + '2161hk1i3551do1i1ak1jj1i2dp0fx1i2zq1fw1i54u2ac1i11b1mt1i0ca0py1i0xf1ky1i3780qu1i3ip0l21i4sy2cd1i5931'
    + 'k11i0fp1ug1i3pd0so1i4441te1i4sx0d81i24j0h91i2dn1r01i4f71ba1i2dp21u1i06u2a41j09j18c1j1u80kk1j3j61wi1j'
    + '0mp1ft1j3780qf1j2cd1nb1j3va1zm1j0eg1551j1ml0yh1j2m81we1j3ha20g1j49r0oh1j5a30li1j1kx0vy1j1p51q81j5a82'
    + 'es1j4mi1ou1j5aa1ro1j0v018l1j28q1ji1j2aw0jp1j4cy1wj1j4e112a1j54r1hg1j11b1oo1j1wz1j41j2o90wb1j3nw1c31j'
    + '42w15g1j0zt0v81k1c715s1k3bd0of1k48x2if1k4nw0d81k02p1941k0iz0le1k2md15s1k3wm0sw1k1si1rk1k23i2471k3d31'
    + 'uv1k3k10tv1k1ou1n71k4p61711k0dm2511k1841a71k1bu11j1k2qp1ez1k2uz0gg1k0bo19g1k1lc1wv1k2090km1k27a0rj1k'
    + '3m50yd1k41z0ga1k0nm1t51k0sg1j11k2ct1751k30n0a91k4410e21k0cp1mj1k0vu1rd1k1sm0sx1k3wx0qh1k5by21j1k2q00'
    + 'cx1k4rw1m41k1031mp1k27e2d11k3nf1mk1k46x0m61k57c1e01k3kv1u61l3md0xg1l39a2ds1l4ua0hj1l14g1h41l20q0vk1l'
    + '4kx1ob1l5cz1291l05527y1l0g40lc1l16020u1l29a0fa1l2q224k1l50k14r1l0rq11x1l45p1u91l5e21fu1l14v1fd1l1di1'
    + '651l1tl0rg1l3o21gi1l4711jb1l4m11hk1l0tl18r1l0v81re1l1dy2861l4vp22f1l0ss1jf1l3f31f21l45429l1l50r0701l'
    + '5an19s1l0fh1891l3se1on1l4x21z51l23l0nu1m44b1fi1m1ac0fa1m1ct12e1m1i01a31m4ez11x1m4ih26r1m57o25y1m0np2'
    + '921m0va21o1m10j1nr1m1b21ck1m1y90d91m20b0o31m3w90h71m4s61mu1m4yp11k1m54b1s31m1nk0au1m1px1tg1m2a32at1m'
    + '2ir0hb1m3ee1ln1m4ta18q1m0qb22x1m2ir1x01m2m71vj1m0qo0xw1m1rq0z41m3lu1jv1m4gq27n1m4ok23z1m12a0x11m2f70'
    + 'hd1m3my1sm1m5gw23t1m0gy1fj1m25m1yg1m2o12gj1m3tn1f41m43523k1m2ey14n1m38f0qm1m3fb0631m0v50e01m0v61vy1m'
    + '11b1mv1m22b0gb1m2fw1j61m2gj0n71m2wi09x1m4721tz1m47x12b1m4l12h11m0za0qi1m1c80ln1m1h30vf1m2de0qm1m2wn2'
    + 'gs1m2x90n11m3ou1mp1m49a1q31m4aw19f1m07w1ze1n12n1621n1a00ub1n3rh0em1n3tz0661n45h1yp1n56c1d81n0vd1rj1n'
    + '2120of1n38h0p41n3en1av1n3ow0xs1n4lm1ek1n01b0ol1n0fs1oq1n2ac1sg1n3io0mx1n5d40ov1n0oi1921n1lj10k1n2501'
    + 'fa1n2us1dn1n4m61xi1n28j1dd1n2ml0jq1n34n0s41n0xs1hc1n1y81bu1n2vw0m31n3hq0nv1n3ly15s1n3s323q1n3xp1v71n'
    + '4hc1431n4x71gx1n03n0pq1n0co0mr1n0o727b1n12e1c51n1s509o1n2kv0h81n3qa12j1n4631fn1n09i0jb1n1s218p1n1sf0'
    + 'xx1n20v1o31n4um20v1n0h52i81o1j313b1o0yj24i1o1dw0q81o2332181o24k0fe1o4hh0pb1o4hn0rg1o4ot24i1o5ev12u1o'
    + '10o0v41o1ct1zr1o1oo0c91o2090ue1o2tm0kx1o3o30vb1o4mr09i1o57e0pu1o59t1r31o0x71xw1o4zq23c1o0go12a1o1g21'
    + 'aj1o2eq08v1o33u28k1o5e30hn1o23c0d41o2n01jv1o3r01371o0ee2661o13o1c71o1mx1pf1o1oe0z51o3ei0t01o3pl2aj1o'
    + '3s30m51o4bz0ab1o4qr1uv1o21p0ym1o2t61091o4ea1md1o4ek1at1o0j31wt1o1652bl1o2151tz1o2zl0i81o46r1fe1o4ra1'
    + 'ka1o5jx1ht1o0yz1a71o2q11hn1o3c626t1o5891dy1o0q925k1o1x907a1o20u0qb1o2mm1hd1o3771ms1o3bj0sy1o3dx0mj1o'
    + '5a816g1o1561li1p1rc1sy1p2n41461p2ug0c91p2uk0eg1p3eq0uh1p3xm0kh1p3aw1ao1p3i80ou1p3jg0hc1p57e2ag1p06l1'
    + 'rh1p0jp0bv1p0m51e71p0pc10w1p1lj17b1p27s0h31p2jn13u1p4dp22f1p4vu14f1p4y21p01p1at1j61p3ns1o31p0dg2101p'
    + '0mt25d1p1t60o91p4a00mr1p4fq0s51p0mb0rv1p1mv15b1p1zw0q41p2a515r1p2g906c1p2q50g01p3m40d61p4fn0sy1p5bs0'
    + 'kp1p0m60c31p0ze24w1p1ec1jd1p2sq1iv1p4m00qr1p4tv0z21p57h0pp1p19019o1p1i11p81p3oh14p1p4t20zz1p59q04s1p'
    + '5h81h51p0ta1l71p0vg1rb1p1zw1h61p2sy0e41p3ll1vf1p3p01sy1p5171s91p55k1yz1p1nz1dq1q40y1yn1q5ha22n1q1el1'
    + 'qx1q1qe1vo1q3py17p1q41c10k1q04l2cz1q0vv0tw1q55o19o1q3ag18b1q3ay23m1q3ue0uf1q55f29p1q58z0yz1q3770uv1q'
    + '4cc1pf1q19y1hb1q1u811a1q2f71ye1q3u321l1q59t1kr1q5b40vx1q0t12bb1q10v1qe1q3vq2nl1q4qs2d01q4yo0dp1q0np1'
    + 'za1q0vi1131q1tr0na1q3q90tk1q3t313r1q48w2hn1q4ck1bd1q4d90fg1q4dl1yi1q4t01v21q4xf1zw1q5do1an1q02s0dz1q'
    + '1sd1u21q31z1ti1q36o0vn1q38w1ev1q3qk22z1q3vb06y1q4f80tf1q5122ao1q51i25e1q09k2px1q0kf0ni1q0mt16b1q2uk0'
    + '5y1q2wp20z1q3tp0uq1q43f16u1q5dv18y1q0aj0bq1q0y925z1q12a1jn1q12f20x1q16y1951q1xu2201q2zf0ro1q3ci2k21q'
    + '51b2by1q09o2491r0en1j31r0rs0q31r0tp11z1r0zk0le1r14u2ev1r22s1kl1r42r0sj1r4681q01r53v2dx1r08r1ie1r0mx1'
    + 'jm1r0zi1iy1r12n1ky1r1371qr1r31b0ma1r3jl0ne1r4hk0p41r4t51my1r5fk1hk1r1101qo1r2852n71r2f40wr1r41h0xf1r'
    + '4oj29f1r4y314n1r54q1wg1r5cm0pu1r0u41e81r18e16o1r2gt0j41r2r10v61r3n42l81r3to14s1r54816b1r57q0w11r5gz2'
    + '211r0850xp1r0kl1ip1r0va1rl1r0vr0t41r10v1nz1r1e023j1r20o1fw1r2j21rr1r2ot1dk1r2qk0ek1r2wg1501r3bi0io1r'
    + '4p41721r20b0gt1r3cf03j1r3ke1ys1r3qd12f1r4s01de1r0u224s1r12y1331r1a51oc1r1g51ue1r21416h1r27f1qr1r2sf0'
    + 'eu1r31q1nr1r37j0vo1r3fu0ps1r40k16v1r1q91iz1r2ze0mt1r3cb0os1r3zt0z81r4770en1r48r1y11r0541wq1r05d1ua1r'
    + '09w28n1r1bw0dh1r1if1101r1xj06y1r2590i11r2840ml1r38x0oo1r3ma0qd1r41d1gb1r4c81yw1r4cj1o41r5171nn1r57g2'
    + '4i1r0qm1oz1s14d1iy1s1iv0kk1s1ly2ag1s1vs0bw1s21e1h91s2vr1tp1s3jh0x91s4252q41s4980fu1s4gm1z71s5190vn1s'
    + '04e0f11s0610i31s0ih1ix1s0t924o1s0xz1qa1s14o1az1s17i16t1s1do0ue1s1lt14j1s1vv1cc1s39i0r41s4jg1da1s00a1'
    + 'ao1s1gb0uh1s1oy1051s2jp0qj1s4781pk1s4mn0ue1s31q1ax1s4nw2l61s5fa12j1s5g90t01s0fs0oa1s0vw2ef1s1ai1ja1s'
    + '1d81pa1s1hb1gk1s1uz1fb1s2cg1jk1s3hf1f61s3wu1jn1s40l12a1s4jw1o01s4k11nq1s4xr0kb1s07y1r01s1t00zl1s1vx1'
    + '3b1s4dx0cn1s5320jg1s1kx0k81s1nw1ut1s3bv0s21s41y1si1s45t1us1s4xi1xe1s5cr2jw1s5e618w1s5ea0vx1s1f21m71s'
    + '1j913v1s1o80p71s1ob0zd1s1wm0rl1s2k01p81s3fn0yh1s3ng1i31s4691eq1s56m2711s5f71r01s0vf17a1s0zg19r1s15a2'
    + '7v1s4g91zr1s4n10ym1s4pz1vw1s4sp1md1s4tb1b71s02113h1s06r1i81s0zm0h21s12z0qr1s1gq2as1s1r211m1s1w90s01s'
    + '1x90tn1s3d70lz1s4ic1rp1s0e31h21s0nh0w01s17d17f1s1fo1lw1s2021fv1s2300r31s2ga0i11s2hp0591s2lz1bz1s3tt1'
    + '231s4gi2ir1s4j21i41s0kp2fg1t0wj1cd1t17i1fl1t24826o1t2la11b1t2t40lv1t3t40nl1t5an0vq1t0my13p1t0ru1u51t'
    + '15h1ey1t1hx0vw1t1il1i31t1uf0mn1t23q09o1t26f1sk1t27u26x1t2qs0ox1t3dh1uj1t3gm1bl1t4x01jk1t5470s11t0682'
    + '4u1t0xg0fh1t1101mo1t1kn1fc1t2cg1dt1t3k90h21t3sp12v1t5c71g41t5cl10t1t0gy2he1t1200xh1t1k41ld1t1o30o11t'
    + '1tn0sf1t2cd1xl1t3ec1n41t4je25w1t4w01041t5151tz1t5hi1f01t5hm15x1t0000dk1t1b41ga1t1cl0it1t2160ih1t2e90'
    + 'iv1t2qc1p81t36w1np1t4ov1tg1t4wc17p1t4z011w1t54i0vo1t5592021t58z22m1t02k1yg1t09y1uq1t1ci1zs1t2720u11t'
    + '28h0fx1t3ms1ox1t4n22fp1t4ss0l61t5051371t5750dx1t5j829y1t0nc1u91t33h0g41t33o0e51t3bc16l1t3hm1sz1t47k0'
    + 'oh1t4hd1551t4sz2a01t4z61r51t57k21y1t04e0f11t06x20u1t1e01cb1t1rj0ul1t3aj26s1t41d1b61t44a0yj1t4t91ya1t'
    + '5df25g1t1871wj1t1iv1191t27g1dc1t27r1y81t27s2gt1t3ft1om1t3ip1301t3k80tj1t4m90yx1t5cn1j81t5fq1l31t00j1'
    + '4d1u0t62aq1u16a0ua1u1mc2ks1u1qh1ko1u2a92811u3lz0p11u3s710l1u4740y71u50u2hm1u56923v1u56r25i1u0nu1xh1u'
    + '0x60fw1u1d31tc1u23x1zd1u2ls1qu1u3cb0ow1u42m0o61u4tx1t21u4vx24h1u0u50rn1u3sv1lt1u3sw10z1u43i2i31u4dm1'
    + 'ql1u4fi0ri1u4lr1re1u1al1bb1u2a60o51u2he0gd1u3210gq1u37h2dy1u3r20yh1u42x19i1u5ej1r71u05r0oe1u0uy0ta1u'
    + '0w02hn1u19e1fq1u2092dr1u2721ch1u2e20jf1u2lf0gi1u3nw1sh1u3og0zx1u4c62001u4jg1061u5ih0yd1u0zv25y1u2c21'
    + '6r1u2j80td1u3ey1nf1u3kj0sh1u3ob21l1u4h72ei1u00r1au1u02d1zi1u0fs1fs1u0qk2001u1q225c1u1un13s1u3lr18f1u'
    + '4re1xl1u07v2aw1u0xc10o1u1631q01u1a419y1u2440zn1u2kd1i31u2kl0fc1u2oi0jv1u2yg0im1u2zl0h51u3t719d1u4621'
    + 'by1u4ao0qi1u4dt1gc1u0ow1pv1u1se0y81u1tp0mg1u20q19z1u2570t81u2xj0rs1u36028e1u3go2en1u3o30zp1u3pu0hw1u'
    + '4ad0fe1u4d42b01u5jp1rz1u0wh10c1u14y1jn1u1ek1p71u36t0lf1u3mh1yd1u3mq0p71u3w91801u4041yq1u4711iv1u4i11'
    + 'e71u4rl1m51u58j26n1u5c925t1u0mp1te1u1211m91u16b1mk1u1d70ey1u1ow0tl1u1qm0wt1u1r90y91u2f50hz1u2s41ho1u'
    + '3ps0mn1u09x1pp1v0f81821v1jp1ji1v1lq12t1v1on0yi1v20o1px1v23s0at1v2iu2201v2xg19k1v2xx0mw1v3mj0uw1v46p0'
    + 'xk1v48i0yz1v49a1911v4mu1tf1v0a91ro1v0t325i1v0ze20i1v12s1mu1v1ev15p1v1wd1nt1v24j2da1v4601nb1v4a215x1v'
    + '4c62011v4iu2gp1v4v60w31v0d22ax1v0fz0cf1v0ha0xq1v0ou2011v22i0kq1v28c1gl1v2bd1ih1v2gq1vs1v34s1aj1v3542'
    + '581v3s606a1v4jt1ur1v50919n1v59e13j1v1111m61v18c20a1v1ro0zx1v1t20nu1v1uu1d81v2gq0h41v2yc0g41v50u26g1v'
    + '53t0ig1v5gj0qc1v18i1271v2or18k1v2p90up1v3wu0qh1v4bv18z1v4m30ze1v4wg1jn1v5aw2ov1v5ga12e1v0oz1iy1v0t30'
    + 'f11v14n1lx1v16g0i31v19t1de1v1a81vw1v25z0zl1v2680xz1v2pw13t1v3170n31v38c0em1v4lv1ip1v4xi0w51v5d211j1v'
    + '0by2fv1v18p1ds1v1cr1yq1v1ff0jh1v1w816t1v26t11l1v2ey1ws1v2fk0a01v2fy20h1v2sm0ex1v2uw1nw1v32s20j1v3pq2'
    + '3l1v3zz1dr1v50x13j1v0k825y1v1ll1lc1v1w90q41v2jx1cm1v3q80ox1v3ql1ya1v4tz1901v04f28a1v0b11t51v0l415j1v'
    + '0m70q61v0rs2eh1v0t91b61v1vx0fy1v20e0nq1v23d2fl1v32w13u1v3a20kb1v3o41po1v45z10s1v4es0qm1v4ir1x51v4uz2'
    + '4e1v53t1ct1v5gx0oq1v1od0n71w2qd0cw1w37q0w91w3ax26j1w3mu1321w3mx0uq1w4rm0gc1w5e92fu1w04d0mw1w0no08b1w'
    + '0nr12c1w1cy1f11w1gm2gi1w1uc0x51w28q10w1w2h70e71w2mc1z81w2vc26n1w3071no1w3451551w37j1x51w3bt0hj1w40q0'
    + 'cd1w43a0mk1w4gl1pw1w50a2ci1w5co1s51w0651841w0ps29i1w1b21a01w1kl1ih1w25r17d1w2nw1cc1w2zk18p1w42t2g71w'
    + '46f19g1w4aj29p1w4n60sx1w4p51z51w4pj16x1w4qo1441w59x2o71w0080771w07d1dd1w0hu1z11w0ve2d71w11l1n01w15o1'
    + '711w1aj1ao1w1vu26m1w1wj0u21w2950yl1w2e31ot1w2v51sd1w32s1h11w3bk0ow1w3bv0yl1w42110p1w44n0rq1w4cb0dz1w'
    + '56b1tr1w5771gm1w0211p81w0ge1r41w14n1ye1w1xt0n21w25x0fc1w32g0ca1w3o41xt1w3tj1021w44i0we1w4611gf1w4os1'
    + 's81w54p2i71w55i0r11w05u2621w07d2by1w0r71941w10c23u1w10o1np1w15v1a11w1jh21m1w24g2fb1w2592801w25u18p1w'
    + '2hh0eh1w2wu1ql1w31c1tc1w39w2l31w3b61xq1w3ep1sr1w3hb1rw1w3rv0y41w4031we1w4oj2401w4u222o1w4xw0rc1w56u1'
    + 'es1w5951ua1w1701mo1w17l0co1w1830um1w1dq1sf1w1uq0ep1w27v2001w2n317z1w3cl1cr1w49j12l1w4s11ps1w4th23m1w'
    + '0ga0no1w17j1ze1w1jg1651w1lg12s1w1r115y1w2eg0qv1w2fl2941w2vp0lf1w35j1y61w3a41ry1w3pn1qo1w3se1el1w3w62'
    + '3k1w3xt1bo1w49m2ef1w4dk2hm1w4vm12z1w56c1ks1w57l1821w5e52581w5hh1441w07n2ar1w0c62381w0m617f1w0n00cg1w'
    + '1nk0rz1w1on1121w1xn0vn1w20k0ki1w30u0mh1w3hj24h1w3is0pa1w3tb21a1w3yc0v21w4ce1st1w4dx1ar1w4e60te1w0cj1'
    + 'hf1w0ii22l1w0j11x01w0rp1fv1w0za1j51w1be1n71w1rt0sq1w1zl0hs1w2jr1g01w2py1il1w3bf1n21w3tv1ke1w3v12dw1w'
    + '3vm29k1w4mj0zg1w59d0r01w59o0ka1w5cl2b01w0qo2jc1w0rm1x01w1qh1181w2cl0l81w3200t01w3jg0eo1w45k0pd1w48w1'
    + 'fw1w4e40kl1w03w0vo1x0rk11i1x1kf2b11x2070xl1x2g72k21x32q0cw1x3bx1ip1x3eg1ij1x3se1v61x3u20pj1x3uq2571x'
    + '42528n1x43p11y1x4c60u71x4dj11d1x4gi0zz1x4rw0ft1x5441gt1x0bg23b1x0ln1h41x0r31pp1x0zc18b1x1o60ow1x20h1'
    + '551x22e0ym1x2aj0zl1x2gi0ys1x2hu0e81x4ks1311x4zu1zf1x0ka1761x19i1q71x1ch1rn1x1d20v81x1ox10d1x2ry06k1x'
    + '2xt1jp1x30d1v41x3x42e71x45p0qu1x4c219e1x4gs13h1x4j80na1x5i72al1x5jt1c11x5jv28z1x01k15f1x14a1yu1x1941'
    + 'f11x1ck1l11x1rs1x81x1sr1oa1x2fp0k61x2gk16k1x2q50ri1x2qv0ds1x2ze1pt1x3b70501x3yf1l31x42528o1x4kh1yr1x'
    + '4tm0v81x58s1zp1x5fu2aj1x06s26b1x0bw15w1x1bk1et1x1m02321x2z10v41x32b0h61x3pt0sk1x3q31301x3ta0b21x4lf1'
    + 'qk1x4tj0ob1x0mj20c1x11r1dz1x15v12v1x16p1od1x1gs1cd1x1nr1bn1x1ny1zu1x2gp14m1x2xu0gu1x3561yo1x3h519a1x'
    + '3j10wi1x3v41451x3yf2891x4m22751x4qs1ce1x4rs1cl1x57x0fk1x5b01iw1x0g711h1x1e91841x1ep14u1x1hg25e1x1mv0'
    + 'mg1x1qn2ns1x2560sl1x2kf0yu1x2vo1t51x3531g11x3791pt1x3ex0ug1x3kd18a1x46y0pv1x48t1q71x4af0oi1x4de2661x'
    + '4sw1s11x0yu0qo1x0zq1pg1x1061x71x15k1z21x1ra0kt1x1sb2am1x1un1by1x22l0h31x28v10q1x2o50xr1x2pc0fi1x2ua1'
    + 'rb1x2z61tb1x30g29b1x3a614y1x3fr1cq1x3i11rt1x3r018f1x4jg1a31x4np0km1x4nz1yh1x4op1yg1x4t81x31x5e019p1x'
    + '5hs1ub1x0ie1uu1x0ov1xk1x1lt0my1x1pf13g1x1v61tg1x21l0ou1x2am13g1x2ep2ef1x2fn09c1x31l1161x32920b1x3t82'
    + 'g71x4ec1vv1x4on1mg1x4qu2571x54r0vx1x0612441y0b42ad1y0wz2d11y1bc1dd1y1fo1mz1y2nk1fl1y2wu2gw1y3p31621y'
    + '3r70jn1y3rs2k31y4m31ze1y4mx0h01y5ak2221y5ff1ep1y5i41fy1y0dz20k1y0e521o1y0ld0yb1y0rz2231y11a1n31y18c1'
    + 'qa1y1da28y1y37913x1y3p128f1y3pt0zn1y46u1qc1y47n10u1y47o1vg1y5f42cm1y0ag0op1y0g42g61y0uw1wv1y0xj0g21y'
    + '1061t71y1dd0te1y1tr1sv1y2ej0cu1y2uu1fu1y34a1lo1y3cl0xm1y3ml10s1y3rp0m71y3y41lu1y5ge1vf1y5h71641y5i22'
    + '3s1y0ea1by1y0hz1sf1y0ou0ef1y16l26o1y1ak1b01y1al1b01y1ry15j1y2081721y2js1he1y2qm0az1y2vr1sx1y3lf20q1y'
    + '3pj1ul1y49c2ao1y4dt1gc1y4h71b01y4m42ap1y00n1861y0h028a1y0sw2591y0uv0w91y0wy2by1y12q17a1y18u1fz1y1l22'
    + '181y1l20ux1y1mr1bn1y1pw1j61y1wj1581y23u1gu1y24j0p31y27g1ka1y2mu2261y2ub1wd1y3650jp1y3ad1fc1y3k30nd1y'
    + '3k81uu1y3pa0qt1y47x2ds1y4hp1ug1y4na0w71y54i0v31y5b625n1y5eb18o1y0xy2av1y1921no1y1f20tb1y1g716e1y1lt1'
    + '671y1ox25h1y2861ht1y2mw0tx1y2pq0fa1y3ld2kz1y3qg1nh1y45v0x71y4712251y4do11f1y4ej2431y4ga2a21y4j51oz1y'
    + '4ks1wr1y5jo0ea1y';
  // Proper names for the brightest stars, keyed by index into STAR_DATA.
  const STAR_NAMES = {"0":"Sirius","1":"Canopus","2":"Arcturus","3":"Rigil Kentaurus","4":"Vega","5":"Capella","6":"Rigel","7":"Procyon","8":"Achernar","9":"Betelgeuse","10":"Hadar","11":"Altair","12":"Acrux","13":"Aldebaran","14":"Spica","15":"Antares","16":"Pollux","17":"Fomalhaut","18":"Mimosa","19":"Deneb","20":"Toliman","21":"Regulus","22":"Adhara","23":"Castor","24":"Gacrux","25":"Shaula","26":"Bellatrix","27":"Elnath","28":"Miaplacidus","29":"Alnilam","30":"Alnair","31":"Alnitak","32":"Regor","33":"Alioth","34":"Mirfak","35":"Kaus Australis","36":"Dubhe","37":"Wezen","38":"Alkaid","39":"Avior","40":"Sargas","41":"Menkalinan","42":"Atria","43":"Alhena","44":"Alsephina","45":"Peacock","46":"Polaris","47":"Mirzam","48":"Alphard","49":"Hamal","50":"Algieba","51":"Diphda","52":"Nunki","53":"Menkent","54":"Alpheratz","55":"Mirach","56":"Saiph","57":"Kochab","58":"Tiaki","59":"Rasalhague","60":"Algol","61":"Almach","62":"Denebola","63":"Navi","64":"Muhlifain","65":"Naos","66":"Aspidiske","67":"Alphecca","68":"Suhail","69":"Mizar","70":"Sadr","71":"Shedar","72":"Eltanin","73":"Mintaka","74":"Caph","76":"Dschubba","77":"Larawag","78":"Men","80":"Merak","81":"Izar","82":"Enif","83":"Mula","84":"Ankaa","85":"Phecda","86":"Sabik","87":"Scheat","88":"Aludra","89":"Alderamin","90":"Markeb","91":"Aljanah","92":"Markab","93":"Menkar","94":"Saik","95":"Alnair","96":"Zosma","97":"Acrab","98":"Arneb","100":"Gienah","101":"Ascella"};
  // Constellation stick figures: 150 polylines, 893 points (6 chars each: ra*20 / (dec+90)*20).
  const LINE_DATA = [
    '0h721j09p1xs05h1v50161u6',
    '07y1r006l1rh05d1ua05h1v50541wq5gz2215by21j',
    '5gz2215ha22n5gw23t',
    '09p1xs07w1ze06x20u09o2490dm251',
    '5ha22n5i223s',
    '2720u12f40wr2j80td',
    '3fb0633s606a3vb06y3tz066',
    '4ta18q4tz1904ze1ax5451du56c1d857c1e05891dy5an19s5e618w5cz129',
    '4ze1ax54816b',
    '5451du55o19o',
    '57c1e056u1es',
    '5ev12u5e618w5hh144',
    '4kr1jw4le1ix4m11hk4o91dk4lm1ek4hv1fq4f31lp4le1ix4hv1fq4f71ba',
    '4170io41z0ga3w90h73xh0iw3xm0kh4230ma4160j5',
    '0nm1t50ho1r10fx1pk0fs1oq',
    '1dy22z17z23k16l20x1591wf19b1tw1dz1yo1dy22z1dy28617z23k15y22c16020u',
    '36w1np37x1o83au1oo3d31uv3d41za3ha20g3j61wi3ex1t13au1oo3ee1ln',
    '3d41za3ay23m3aj26s3c626t3ay23m',
    '11m0p112z0qr1360td16a0ua',
    '15a27v1652bl14u2ev0w02hn0vw2ef0t12bb',
    '14u2ev1gm2gi1mc2ks',
    '22s1kl20v1o320o1px2151tz',
    '20v1o31wz1j4',
    '2zs1za2wp20z',
    '1h51411ka14q1mr10r1ni0zc1ml0yh1m50xx1gu0xb',
    '1po0xq1ni0zc',
    '1ka14q1lt14j1mv15b1lj17b1lt14j',
    '1rt1gw1q41im',
    '4p41724pl15s4qo1444t20zz4tv0z24yp11k51j15150k14r4y314n4vu14f4p4172',
    '1j90q01hc0kq24u0ba2d90b32hb0e82fs0fq2dp0fx25d0h21xt0gy1u80kk1w00np20w0jm25d0h2',
    '2hb0e82kl0fc2kv0fl2lf0gi2kv0h82ir0hb2fs0fq',
    '0fw2dd0bx2bh07w2bq05n29f01a2av',
    '2ml0jq2t60lu2vw0m32xs0mt35v0kb3820nq3780qf3780qu39l0tt3dm0ql3gw0qm',
    '3780qu3370tm',
    '3e60g735v0kb3970gh',
    '2vw0m32tm0kx2o30gz',
    '4qs2d04sy2cd4xl2cs5122ao55f29p54u2ac57e2ag5a82es5h52l54yz2h74xl2cs',
    '4yz2h75a82es',
    '0mp1ft0ln1h40kl1ip0mx1jm0oz1iy0pb1ga0mp1ft0m51e70jd1cc0fh1890eg15506214002p19409j18c0bo19g0fh189',
    '1x907a2g906c2hm05b2uk05y2ry06k2g906c',
    '3jg0hc3el0dw3k90h2',
    '1h30vf1cr0u51b60v31a00ub',
    '1cr0u51dw0q8',
    '31q1nr31z1ti2vr1tp',
    '4e60te4f80tf4fn0sy4fq0s54fi0ri4es0qm4cw0pv4ao0qi',
    '3ll1vf3kv1u63lt1su3my1sm3nw1sh3p01sy3pj1ul',
    '2t61092tf11g2u71492w514u2ws1102tf11g',
    '2or18k2n317z2md15s2jn13u2la11b2mx13k2n41462pw13t2rg14h',
    '2md15s2n4146',
    '2yn0gu2u40hd',
    '2vp0ey2wc0ia',
    '4wt1ut4t31wv4pr20d4kl2334ih26r4gq27n',
    '4sf2364pr20d4m61xi4im1tj',
    '4ra1ka4rw1m44s61mu4t51my4sp1md4rw1m4',
    '0zk0le1220jf1ac0fa1bw0dh1d70ey1ac0fa16g0i31220jf',
    '45429l45j26m41w27242528n45429l4g32fl48w2hn3yw2ei3so2c63pl2aj3kh2ar39a2ds2wn2gs2o12gj',
    '48w2hn48x2if',
    '4g32fl4l12h1',
    '4x71gx4x01jk4wg1jn',
    '16r1b613o1c712e1c50yz1a70x216i0vf17a0v018l0tl18r0oi1920mt16b0my13p0pc10w0rq11x0tp11z0vi11312a0x110o0'
    + 'v40zt0v80vv0tw0u50rn0rs0q30or0rm0mb0rv0kf0ni0iz0le0g40lc0dl0i7',
    '0qo0xw0nh0w00ha0xq',
    '1g21qi1h71qi1k41rz1nw1ut1r51vq1sn1tl1rc1sy1p51q81mx1pf1j91n41ka1l6',
    '1p51q81ou1n7',
    '5bs0kp5a30li5990ny57h0pp54h0nx5990ny',
    '57e0pu55i0r15470s152i0t9',
    '3se1on3tj1py3v21vk3va1zm3u321l3s323q3qk22z3ob21l',
    '3v21vk3xp1v7',
    '3va1zm3zr1yg',
    '45h1yp40y1yn3zr1yg3xp1v73zr1rt4441te45p1u94721tz',
    '3zp1m03tj1py',
    '0za0qi0ml0ls0lv0kt0mb0jp0pi0gt0ou0ef',
    '2161hk21e1h920o1fw2021fv1zw1h62161hk22d1hb2501fa28j1dd26u1972a515r2ct1752ey14n2i81502o90wb2r10v632z1'
    + '1539k0z63fn0yh',
    '03l0730vk08r0m60c30jp0bv0fz0cf0gi0ft',
    '4rw0nq4ss0l64ua0hj5320jg4xr0kb4rw0nq',
    '56m27157o25y57g24i56923v57k21y58z22m57g24i56r25i56m271',
    '57k21y55920255k1yz',
    '2ci1kn2cd1nb2e41p12ln1pe2qh1m32ln1ml2ci1kn',
    '2e41p12dn1r02ac1sg29d1r7',
    '2cd1xl2ey1ws2ir1x02f71ye2cd1xl27r1y8',
    '1ev15p1di1651c715s1a814417h15016f11l19l12h1bu11j1ct12e',
    '17i16t17h15018e16o',
    '3hk0zy3fq1533jd18s3ly15s3m50yd3md0xg',
    '3fq1533ly15s',
    '3o30vb3mj0uw3k10tv3jz0rf3gt0q13ei0no3ip0l23jl0ne3k50p63lw0r53pd0so3q90tk',
    '3jz0rf3lw0r5',
    '1gq2as1ly2ag1q225c1xu22023321825m1yg25x1x4',
    '4c81yw4c62004b51zk4c81yw4dl1yi4e71w64cy1wj4c81yw',
    '1ff08h1a307l15008d1620ae',
    '4tm0v84te0pk4xw0rc4xi0w54v60w34tm0v8',
    '1s218p1vv1cc1nz1dq1i01a31g21aj',
    '1nz1dq1kn1fc1hb1gk1il1i31jp1ji',
    '2q00cx2ug0c92x60bl2yf0c630n0a92wi09x2x60bl',
    '3q80ox3t40nl3s30m53ps0mn3q80ox',
    '3cf03j59q04s50r0703cf03j',
    '45v18l44b1fi43p1gj42j1kz3xc1j83tn1f43rc1by3rw1be3ui1853z415a',
    '3xc1j83ui1853to14s3t313r3sp12v3sw10z',
    '43p1gj3z415a40q10441h0xf',
    '1f21m71d81pa1ek1p71fo1lw1ec1jd1dc1i41961hj14y1jn',
    '15h1ey14v1fd14g1h41491hv14d1iy14y1jn1561li16b1mk1701mo',
    '17p19g1921co1a41du1961hj1ak1jj1dc1i41bc1cx1cb18n',
    '1bc1cx1ap1dc1a41du',
    '4q80ih4sx0d84nw0d84d90fg4980fu4770en4410e24bz0ab4mr09i4sx0d84yo0dp',
    '54q1wg59b1us5c71tm0161u601u1mg5cc1mg59t1kr5931k154r1hg5151ji',
    '5cc1mg5c71tm5aa1ro59t1r354b1s35171s9',
    '0v61vy0wj1vq0x71xw0x12080va21o0uz24k0u224s0se25p0po27q0np2920o727b0q925k0qb22x0q520r0qk2000pq1zl0ou2'
    + '010oy20t0q520r',
    '0y925z0ze24w0yj24i0uz24k',
    '0q925k0mt25d0ee266',
    '03n0qi0960o20ca0py0co0mr09i0jb0960o201b0ol03n0qi',
    '1kp0fl1cl0it1c80ln',
    '0a91ro09y1uq0b11t50a91ro09x1pp0cp1mj0en1j30gy1fj0fs1fs0e31h20cj1hf0a91i808r1ie06r1i85jx1ht5h81h55fk1'
    + 'hk5ei1h05e21fu5ff1ep5hi1f05i41fy5h81h5',
    '5e21fu5c71g4',
    '58z0yz5bc0xk5b40vx5an0vq57q0w154i0vo5190vn51n0wu54i0vo58z0yz',
    '1j90q01oq0te1r90y91rq0z41t61071u811a1vq10i1v60rs1w00np',
    '1t61071t00zl1sf0xx1r90y9',
    '1v60rs2090ue20q0vk21p0ym',
    '0zc0fb0zm0h20x60fw0v50e00zc0fb',
    '4jw1o04kx1ob4mi1ou',
    '4k11nq4kx1ob',
    '48g0tl49d0uw48x0xf49w0zw47x12b',
    '4hh0pb4hn0rg4ep0xe4cc0z049w0zw',
    '4m00qr4mn0ue4m30ze4jg1064hu10e4gi0zz4do0ze4cc0z048x0xf46t0x449d0uw4ep0xe4fb0yn4do0ze4ez11x4fp12c4gs1'
    + '3h4hc1434hd155',
    '4ez11x4e112a4dj11d4do0ze',
    '3p60zi3pe11g3q3130',
    '3pe11g3sa0zs3tf0zb3ub0yc3wb0uy3wj0sv3wx0qh3zd0pz42v0q444a0rp43k0sb42c0te',
    '0850xp5ih0yd5ea0vx5g90t0',
    '4aw19f4ck1bd4bv18z4a215x4aw19f',
    '3nf1mk3ms1ox3ns1o33ou1mp3nf1mk3lu1jv3n51hl3o21gi3rc1by',
    '3z415a42w15g45v18l46f19g48z1ce4dt1gc',
    '2cg1dt2ab19i2ff1ch2fj1dn',
    '1aw1pr12c1n611b1mt1031mp10j1nr11b1oo19b1tw',
    '1031mp0xf1ky0ss1jf0xs1hc',
    '0ss1jf0sg1j10u41e8',
    '47k0oh49r0oh4a00mr',
    '0fp1ug0i01xg0j31wt0fp1ug',
    '3w30bn3oo0er3jn0bu3w30bn',
    '55x0gj5e30hn04e0f102s0dz0000dk5750dx55x0gj',
    '2u529p2k72cb2jx29c2r527u2u529p2zi29333o28j36y25e',
    '2r527u2q224k2m81we2m71vj',
    '2q224k2l022q2eg212',
    '2l022q2dp21u',
    '2k72cb27e2d11yv2bq2a32at2jx29c',
    '2jx29c2a928127k26q22w24p',
    '23i24727k26q',
    '3n42l83rs2k33jw2hx3fq2j73n42l83vq2nl4252q40l32rl',
    '20w0jm2630jg2aw0jp2hu0mk2de0qm27a0rj2440pv1w00np',
    '2q11hn2qp1ez2us1dn2xs1d731q1ax33u17t3aw1ao3en1av',
    '30n1k32zq1fw2xs1d7',
    '31q1ax3551do38w1ev3f31f2',
    '23c0d41y90d91vs0bw1oo0c91nk0au1vs0bw23c0d4',
    '4gl1pw4ic1rp4lr1re4mu1tf4ov1tg',
  ];
  // Constellation labels: [name, ra deg, dec deg] at d3-celestial's display anchors.
  const CONST_LABELS = [["Andromeda",0.8,43],["Antlia",156.0,-36],["Apus",240.0,-74],["Aquarius",337.5,-5],["Aquila",291.0,8],["Ara",258.0,-56],["Aries",42.0,22],["Auriga",82.5,37],["Boötes",223.5,35],["Caelum",73.5,-42],["Camelopardalis",84.0,72],["Cancer",128.2,27],["Canes Venatici",192.0,43],["Canis Major",97.5,-26],["Canis Minor",109.5,5],["Capricornus",315.0,-22],["Carina",144.0,-66],["Cassiopeia",354.0,55.5],["Centaurus",199.5,-40],["Cepheus",337.5,71],["Cetus",28.5,-5],["Chamaeleon",189.0,-81],["Circinus",217.5,-67],["Columba",85.5,-39],["Coma Berenices",193.5,24],["Corona Austrina",282.0,-40],["Corona Borealis",238.5,32],["Corvus",186.0,-19.5],["Crater",174.8,-15],["Crux",193.5,-62],["Cygnus",307.5,50],["Delphinus",309.0,6],["Dorado",76.5,-64],["Draco",268.5,64],["Equuleus",320.2,11.5],["Eridanus",52.5,-18],["Fornax",40.5,-28],["Gemini",107.2,23.5],["Grus",342.0,-41.5],["Hercules",253.5,35],["Horologium",51.0,-52],["Hydra",150.0,-22],["Hydrus",34.5,-72],["Indus",318.0,-55.5],["Lacerta",342.0,47],["Leo",159.0,15],["Leo Minor",157.5,30],["Lepus",88.5,-25],["Libra",231.0,-26],["Lupus",228.8,-35],["Lynx",121.5,49],["Lyra",279.0,30],["Mensa",82.5,-80],["Microscopium",316.5,-37],["Monoceros",114.8,-6],["Musca",195.0,-73],["Norma",243.0,-52],["Octans",300.0,-80],["Ophiuchus",258.0,3],["Orion",84.0,13],["Pavo",297.0,-62],["Pegasus",334.5,16],["Perseus",66.0,45],["Phoenix",16.5,-43],["Pictor",82.5,-50],["Pisces",19.5,15],["Piscis Austrinus",333.0,-29],["Puppis",111.0,-46],["Pyxis",132.0,-24],["Reticulum",55.5,-61],["Sagitta",291.0,18],["Sagittarius",292.5,-34],["Scorpius",249.0,-38],["Sculptor",1.5,-33],["Scutum",282.0,-12.5],["Serpens Caput",232.5,5],["Serpens Cauda",280.5,3],["Sextans",157.5,-7],["Taurus",54.0,15],["Telescopium",277.5,-54],["Triangulum",27.0,34],["Triangulum Australe",240.0,-67.5],["Tucana",348.0,-64],["Ursa Major",165.0,48],["Ursa Minor",226.5,68],["Vela",143.2,-46],["Virgo",199.5,-4],["Volans",111.0,-73],["Vulpecula",295.5,21]];

  // ════════════════════════════════════════════════════════════════════
  // CORE  (pure math, no DOM -- exposed on global.SkyMapCore for Node tests)
  // ════════════════════════════════════════════════════════════════════
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const sin = (d) => Math.sin(d * D2R), cos = (d) => Math.cos(d * D2R);
  const asin = (x) => Math.asin(Math.max(-1, Math.min(1, x))) * R2D;
  const acos = (x) => Math.acos(Math.max(-1, Math.min(1, x))) * R2D;
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const norm180 = (d) => { const x = norm360(d); return x > 180 ? x - 360 : x; };

  // base-36 fixed-width decode: w chars of s starting at i
  function b36(s, i, w) {
    let n = 0;
    for (let k = 0; k < w; k++) {
      const c = s.charCodeAt(i + k);
      n = n * 36 + (c < 58 ? c - 48 : c - 87);
    }
    return n;
  }
  // -> [{ra, dec, mag, name?}] brightest first
  function decodeStars() {
    const out = [];
    for (let i = 0; i * 8 < STAR_DATA.length; i++) {
      out.push({
        ra: b36(STAR_DATA, i * 8, 3) / 20,
        dec: b36(STAR_DATA, i * 8 + 3, 3) / 20 - 90,
        mag: b36(STAR_DATA, i * 8 + 6, 2) / 10 - 2,
        name: STAR_NAMES[i] || null,
      });
    }
    return out;
  }
  // -> [[{ra,dec}, ...], ...] one array per polyline
  function decodeLines() {
    return LINE_DATA.map((s) => {
      const pts = [];
      for (let i = 0; i * 6 < s.length; i++) {
        pts.push({ ra: b36(s, i * 6, 3) / 20, dec: b36(s, i * 6 + 3, 3) / 20 - 90 });
      }
      return pts;
    });
  }

  // Greenwich mean sidereal time (deg) from a UT Julian Day (Meeus 12.4 --
  // same expression as global.Almanac's, duplicated so CORE stands alone).
  const jdFromMs = (ms) => ms / 86400000 + 2440587.5;
  function gmst(jdUT) {
    const T = (jdUT - 2451545.0) / 36525;
    return norm360(280.46061837 + 360.98564736629 * (jdUT - 2451545.0)
      + 0.000387933 * T * T - T * T * T / 38710000);
  }
  // Equatorial (J2000-ish ra/dec, deg) -> horizontal alt/az (deg; az from
  // North through East, NOAA convention -- matches Almanac's bodies).
  function altAz(ra, dec, ms, lat, lon) {
    const H = norm180(gmst(jdFromMs(ms)) + lon - ra);
    const alt = asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H));
    let az = acos((sin(dec) - sin(lat) * sin(alt)) / (cos(lat) * cos(alt)));
    if (!isFinite(az)) az = 0;
    if (sin(H) > 0) az = 360 - az;
    return { alt, az };
  }
  // Stereographic all-sky projection: zenith at the centre, horizon a circle
  // of radius R. North up, east LEFT (a sky chart is read overhead, so it
  // mirrors a ground map). Returns canvas-style coords (y grows downward)
  // centred on (0,0).
  function project(alt, az, R) {
    const r = R * Math.tan((90 - alt) * Math.PI / 360);
    return { x: -r * sin(az), y: -r * cos(az) };
  }

  global.SkyMapCore = { decodeStars, decodeLines, CONST_LABELS, gmst, altAz, project };

  // ════════════════════════════════════════════════════════════════════
  // UI  (browser only -- bail out cleanly under Node / before the hook loads)
  // ════════════════════════════════════════════════════════════════════
  if (typeof document === 'undefined' || typeof global.ExtrasRegisterTool !== 'function') return;

  const RT = global.ExtrasRegisterTool;
  const U = global.ExtrasUtil || {};
  const A = global.Almanac;
  const tz = () => (U.appTz ? U.appTz() : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));

  // ── CSS (no backticks inside this template literal!) ──
  const style = document.createElement('style');
  style.textContent = `
  #extras_skymap input {
    padding: 8px; font-size: 14px; border-radius: var(--ui-radius);
    border: 1px solid var(--ui-border); background: var(--ui-input-bg);
    color: var(--ui-text); font-family: inherit; min-width: 0; flex: 1;
  }
  .sky-wrap { position: relative; margin: 2px 0 0; }
  .sky-wrap canvas { display: block; width: 100%; height: auto; border-radius: 12px; touch-action: pan-y; }
  .sky-info { text-align: center; font-size: 13px; min-height: 18px; margin: 6px 0 2px;
    color: var(--ui-muted); font-variant-numeric: tabular-nums; }
  .sky-info b { color: var(--ui-text); }
  .sky-time { text-align: center; font-size: 14px; font-weight: 600; margin: 2px 0;
    font-variant-numeric: tabular-nums; }
  .sky-slider { width: 100%; margin: 2px 0 0; accent-color: var(--ui-accent); }
  .sky-toggles { display: flex; gap: 6px; justify-content: center; margin: 8px 0 2px; flex-wrap: wrap; }
  .sky-toggles button, .sky-now {
    padding: 5px 11px; font-size: 12.5px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--ui-border); background: var(--ui-input-bg);
    color: var(--ui-muted); font-family: inherit;
  }
  .sky-toggles button.on { background: var(--ui-accent-soft, rgba(120,140,255,0.13));
    color: var(--ui-text); border-color: var(--ui-accent); }
  .sky-now { color: var(--ui-text); }
  `;
  document.head.appendChild(style);

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (az) => COMPASS[Math.round(norm360(az) / 22.5) % 16];

  const PLANETS = [
    ['Mercury', '#c9b8a2'], ['Venus', '#f3ecd0'], ['Mars', '#e07850'],
    ['Jupiter', '#e8d5a8'], ['Saturn', '#e2cd90'],
  ];

  // prefs
  const PREF_KEY = 'cc.skymap';
  let prefs = { lines: 1, labels: 1, ecl: 0 };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (_) {}
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) {} };

  // decoded once, lazily on first open
  let STARS = null, LINES = null;

  function buildSky(view) {
    view.innerHTML =
      '<div class="xt-row">'
      + '<input type="number" class="sky-lat" step="any" min="-90" max="90" inputmode="decimal" placeholder="latitude" aria-label="latitude">'
      + '<input type="number" class="sky-lon" step="any" min="-180" max="180" inputmode="decimal" placeholder="longitude" aria-label="longitude">'
      + '<button class="xt-mini sky-loc" type="button" title="use map position">\u{1F4CD}</button>'
      + '</div>'
      + '<div class="sky-wrap"><canvas></canvas></div>'
      + '<div class="sky-info">tap a star or planet to identify it</div>'
      + '<div class="sky-time"></div>'
      + '<input type="range" class="sky-slider" min="-720" max="720" step="5" value="0" aria-label="time offset">'
      + '<div class="sky-toggles">'
      + '<button type="button" data-k="lines">lines</button>'
      + '<button type="button" data-k="labels">names</button>'
      + '<button type="button" data-k="ecl">ecliptic</button>'
      + '<button type="button" class="sky-now">now</button>'
      + '</div>';

    const canvas = view.querySelector('canvas'), ctx = canvas.getContext('2d');
    const info = view.querySelector('.sky-info'), timeEl = view.querySelector('.sky-time');
    const slider = view.querySelector('.sky-slider');
    const latEl = view.querySelector('.sky-lat'), lonEl = view.querySelector('.sky-lon');

    let hits = [];       // tap targets from the last draw
    let lastLoc = null;  // remembered so the 30s ticker can redraw
    // view transform: the dome is stereographic, so zoom = scale R, pan = move
    // the dome centre — all projected geometry follows linearly.
    let zoom = 1, panX = 0, panY = 0, vs = 320;

    function readLoc() {
      const lat = parseFloat(latEl.value), lon = parseFloat(lonEl.value);
      if (isFinite(lat) && isFinite(lon)) return { lat, lon };
      return U.getMapLoc ? U.getMapLoc() : null;
    }
    function fillLocFromMap() {
      const m = U.getMapLoc && U.getMapLoc();
      if (!m) return false;
      latEl.value = m.lat.toFixed(4);
      lonEl.value = m.lon.toFixed(4);
      return true;
    }

    const curMs = () => Date.now() + slider.value * 60000;

    function fmtWhen(ms) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }).format(ms);
      } catch (_) { return new Date(ms).toString(); }
    }

    // linear colour blend between two [r,g,b] by t 0..1
    const lerp3 = (a, b, t) => 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';

    function draw() {
      const loc = readLoc();
      lastLoc = loc;
      const cssW = view.clientWidth || 320;
      const size = Math.min(cssW, 430);
      vs = size;
      const dpr = Math.min(global.devicePixelRatio || 1, 3);
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      hits = [];

      const ms = curMs();
      timeEl.textContent = fmtWhen(ms) + (slider.value === '0' ? '' : '  (' + (slider.value > 0 ? '+' : '') + Math.round(slider.value / 6) / 10 + ' h)')
        + (zoom > 1.01 ? ' · ' + (Math.round(zoom * 10) / 10) + '×' : '');

      if (!loc) {
        info.innerHTML = '<span class="xt-muted">pan the map to your spot and tap \u{1F4CD} — or type a lat/lon</span>';
        return;
      }
      const lat = loc.lat, lon = loc.lon;
      if (!STARS) { STARS = decodeStars(); LINES = decodeLines(); }

      const cx = size / 2 + panX, cy = size / 2 + panY, R = (size / 2 - 14) * zoom;
      const P = (alt, az) => { const p = project(alt, az, R); return { x: cx + p.x, y: cy + p.y }; };

      // sky tint + star fade from the sun's altitude
      const sunAA = A ? A.sunAltAz(ms, lat, lon) : { alt: -90, az: 0 };
      const dayT = Math.max(0, Math.min(1, (sunAA.alt + 15) / 15));       // 0 night .. 1 day
      const starFade = Math.max(0, Math.min(1, (-sunAA.alt - 2) / 10));   // 1 night .. 0 day

      // dome background
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, lerp3([7, 11, 24], [58, 110, 168], dayT));
      g.addColorStop(1, lerp3([13, 19, 38], [122, 163, 204], dayT));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, 2 * Math.PI);
      ctx.fill();

      // everything in the sky clips to the horizon circle
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, 2 * Math.PI);
      ctx.clip();

      // faint altitude rings at 30 and 60 degrees
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.setLineDash([2, 5]);
      ctx.lineWidth = 1;
      for (const a of [30, 60]) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * Math.tan((90 - a) * Math.PI / 360), 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // ecliptic (dashed amber great circle)
      if (prefs.ecl) {
        const eps = 23.4393;
        ctx.strokeStyle = 'rgba(230,190,120,0.30)';
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        let pen = false;
        for (let L = 0; L <= 360; L += 4) {
          const ra = norm360(Math.atan2(sin(L) * cos(eps), cos(L)) * R2D);
          const dec = asin(sin(L) * sin(eps));
          const aa = altAz(ra, dec, ms, lat, lon);
          if (aa.alt < -8) { pen = false; continue; }
          const p = P(aa.alt, aa.az);
          if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
          pen = true;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // constellation stick figures
      if (prefs.lines) {
        ctx.strokeStyle = 'rgba(140,170,255,' + (0.10 + 0.16 * starFade) + ')';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const poly of LINES) {
          let prev = null;
          for (const pt of poly) {
            const aa = altAz(pt.ra, pt.dec, ms, lat, lon);
            const cur = aa.alt > -25 ? P(aa.alt, aa.az) : null;
            if (prev && cur) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(cur.x, cur.y); }
            prev = cur;
          }
        }
        ctx.stroke();
      }

      // stars — zooming in reveals more named-star labels
      if (starFade > 0.02) {
        const labelMag = Math.min(4.4, 2.0 + (zoom - 1) * 0.7);
        ctx.fillStyle = '#eef2ff';
        for (let i = 0; i < STARS.length; i++) {
          const s = STARS[i];
          const aa = altAz(s.ra, s.dec, ms, lat, lon);
          if (aa.alt < -0.5) continue;
          const p = P(aa.alt, aa.az);
          if (p.x < -24 || p.x > size + 24 || p.y < -24 || p.y > size + 24) continue;
          const r = Math.max(0.5, 2.1 - s.mag * 0.42);
          ctx.globalAlpha = starFade * Math.max(0.35, Math.min(1, 1.15 - s.mag * 0.13));
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
          ctx.fill();
          if (s.name || s.mag <= 4.6) {
            hits.push({ x: p.x, y: p.y, name: s.name, mag: s.mag, alt: aa.alt, az: aa.az, kind: s.name ? 'star' : 'faint' });
          }
          if (prefs.labels && s.name && s.mag <= labelMag) {
            ctx.font = '10px system-ui, sans-serif';
            ctx.globalAlpha = 0.8 * starFade;
            ctx.fillText(s.name, p.x + 4, p.y - 4);
          }
        }
        ctx.globalAlpha = 1;
      }

      // constellation labels
      if (prefs.labels && starFade > 0.02) {
        ctx.font = '600 9.5px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(150,175,235,' + (0.55 * starFade) + ')';
        ctx.textAlign = 'center';
        for (const [name, ra, dec] of CONST_LABELS) {
          const aa = altAz(ra, dec, ms, lat, lon);
          if (aa.alt < 4) continue;
          const p = P(aa.alt, aa.az);
          if (p.x < -40 || p.x > size + 40 || p.y < -20 || p.y > size + 20) continue;
          ctx.fillText(name.toUpperCase(), p.x, p.y);
        }
        ctx.textAlign = 'left';
      }

      // planets (Almanac's Schlyter positions; bright ones show in twilight)
      if (A) {
        ctx.font = '600 10px system-ui, sans-serif';
        for (const [name, color] of PLANETS) {
          const aa = A.planetAltAz(name, ms, lat, lon);
          if (aa.alt < -0.5) continue;
          const a = aa.mag < 0
            ? Math.max(0, Math.min(1, (-sunAA.alt - 1) / 5))
            : starFade;
          if (a < 0.03) continue;
          const p = P(aa.alt, aa.az);
          ctx.globalAlpha = a;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.6, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillText(name, p.x + 5, p.y + 3);
          ctx.globalAlpha = 1;
          hits.push({ x: p.x, y: p.y, name, mag: aa.mag, alt: aa.alt, az: aa.az, kind: 'planet' });
        }

        // meteor shower radiants — only while a shower is active, and only
        // once the sky is dark enough for meteors to show
        if (A.activeShowers && starFade > 0.05) {
          const fmtPeak = (pk) => {
            try {
              return new Intl.DateTimeFormat(undefined, { timeZone: tz(), month: 'short', day: 'numeric' }).format(pk);
            } catch (_) { return ''; }
          };
          ctx.font = '600 10px system-ui, sans-serif';
          for (const sh of A.activeShowers(ms)) {
            const s = sh.shower;
            const aa = altAz(s.ra, s.dec, ms, lat, lon);
            if (aa.alt < 2) continue;
            const p = P(aa.alt, aa.az);
            ctx.globalAlpha = 0.9 * starFade;
            ctx.strokeStyle = '#a8e8b0';
            ctx.lineWidth = 1.2;
            // radiant glyph: open circle with four outward rays
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3.6, 0, 2 * Math.PI);
            for (let k = 0; k < 4; k++) {
              const th = Math.PI / 4 + k * Math.PI / 2;
              ctx.moveTo(p.x + 5.6 * Math.cos(th), p.y + 5.6 * Math.sin(th));
              ctx.lineTo(p.x + 10 * Math.cos(th), p.y + 10 * Math.sin(th));
            }
            ctx.stroke();
            ctx.fillStyle = 'rgba(168,232,176,0.9)';
            ctx.fillText(s.name, p.x + 7, p.y - 6);
            ctx.globalAlpha = 1;
            hits.push({ x: p.x, y: p.y, name: s.name + ' radiant', mag: null, alt: aa.alt, az: aa.az, kind: 'shower',
              extra: 'ZHR ~' + s.zhr + ' · peak ' + fmtPeak(sh.peakMs) });
          }
        }

        // moon with its real phase (two-arc glyph like the almanac's SVG)
        const mAA = A.moonAltAz(ms, lat, lon);
        if (mAA.alt > -0.5) {
          const p = P(mAA.alt, mAA.az);
          const ph = A.moonPhase(A.jde(jdFromMs(ms)));
          drawMoon(ctx, p.x, p.y, 7, ph.cycle, lat < 0);
          ctx.fillStyle = 'rgba(242,227,174,0.9)';
          ctx.font = '600 10px system-ui, sans-serif';
          ctx.fillText('Moon', p.x + 9, p.y + 3);
          hits.push({ x: p.x, y: p.y, name: 'Moon', mag: null, alt: mAA.alt, az: mAA.az, kind: 'moon', extra: Math.round(ph.illum * 100) + '% lit' });
        }

        // sun
        if (sunAA.alt > -1) {
          const p = P(sunAA.alt, sunAA.az);
          const sg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16);
          sg.addColorStop(0, 'rgba(255,240,180,0.95)');
          sg.addColorStop(1, 'rgba(255,240,180,0)');
          ctx.fillStyle = sg;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 16, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillStyle = '#fff3c4';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5, 0, 2 * Math.PI);
          ctx.fill();
          hits.push({ x: p.x, y: p.y, name: 'Sun', mag: null, alt: sunAA.alt, az: sunAA.az, kind: 'sun' });
        }
      }

      ctx.restore();

      // horizon ring + cardinal points (E left of N: sky charts are mirrored)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // letters sit just INSIDE the dome — outside it the sheet background
      // can be light, which made white text invisible
      ctx.fillText('N', cx, cy - R + 9);
      ctx.fillText('S', cx, cy + R - 9);
      ctx.fillText('E', cx - R + 9, cy);
      ctx.fillText('W', cx + R - 9, cy);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // little two-arc moon-phase glyph (canvas port of the almanac's moonSvg)
    function drawMoon(c, x, y, r, cycle, mirror) {
      const cosp = Math.cos(2 * Math.PI * cycle), rx = Math.abs(cosp) * r, waxing = cycle < 0.5;
      c.save();
      c.translate(x, y);
      if (mirror) c.scale(-1, 1);
      c.fillStyle = '#39404e';
      c.beginPath();
      c.arc(0, 0, r, 0, 2 * Math.PI);
      c.fill();
      c.fillStyle = '#f2e3ae';
      c.beginPath();
      // lit side: semicircle on the east/west limb + half-ellipse terminator.
      // Sweep flags mirror the SVG version: waxing lights the right limb.
      c.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, !waxing);
      c.ellipse(0, 0, rx, r, 0, Math.PI / 2, -Math.PI / 2, cosp > 0 ? waxing : !waxing);
      c.fill();
      c.restore();
    }

    // tap to identify the nearest object
    function identify(x, y) {
      let best = null, bd = 22 * 22;
      for (const h of hits) {
        const d = (h.x - x) * (h.x - x) + (h.y - y) * (h.y - y);
        if (d < bd) { bd = d; best = h; }
      }
      if (!best) {
        info.textContent = zoom > 1.01 ? 'drag to pan · double-tap to zoom (resets at max)' : 'tap a star or planet to identify it';
        return;
      }
      const nm = best.name || 'star';
      const parts = [];
      if (best.mag != null) parts.push('mag ' + (Math.round(best.mag * 10) / 10));
      if (best.extra) parts.push(best.extra);
      parts.push('alt ' + Math.round(best.alt) + '°');
      parts.push(compass(best.az) + ' ' + Math.round(best.az) + '°');
      info.innerHTML = '<b>' + nm + '</b> · ' + parts.join(' · ');
    }

    // ── zoom + pan gestures: pinch / wheel / double-tap, one-finger drag ──
    const ptrs = new Map();
    let pinched = false, moved = 0, lastTapT = 0, lastTapX = 0, lastTapY = 0;
    const clampPan = () => {
      const lim = Math.max(0, (vs / 2 - 14) * (zoom - 1));
      panX = Math.min(lim, Math.max(-lim, panX));
      panY = Math.min(lim, Math.max(-lim, panY));
    };
    // page scroll keeps working over the chart until you actually zoom in
    const syncTA = () => { canvas.style.touchAction = zoom > 1.01 ? 'none' : 'pan-y'; };
    function zoomAt(ax, ay, f) {
      const nz = Math.min(8, Math.max(1, zoom * f));
      f = nz / zoom;
      panX = ax - (ax - (vs / 2 + panX)) * f - vs / 2;
      panY = ay - (ay - (vs / 2 + panY)) * f - vs / 2;
      zoom = nz < 1.02 ? 1 : nz;
      clampPan(); syncTA(); draw();
    }
    const evXY = (ev) => {
      const r = canvas.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (ev) => {
      const p = evXY(ev);
      ptrs.set(ev.pointerId, p);
      try { canvas.setPointerCapture(ev.pointerId); } catch (_) {}
      if (ptrs.size === 1) { pinched = false; moved = 0; }
      else pinched = true;
    });
    canvas.addEventListener('pointermove', (ev) => {
      const prev = ptrs.get(ev.pointerId);
      if (!prev) return;
      const p = evXY(ev);
      if (ptrs.size === 2) {
        let other = null;
        ptrs.forEach((v, id) => { if (id !== ev.pointerId) other = v; });
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y) || 1;
        const d1 = Math.hypot(p.x - other.x, p.y - other.y) || 1;
        panX += (p.x - prev.x) / 2;                 // midpoint drift pans
        panY += (p.y - prev.y) / 2;
        zoomAt((p.x + other.x) / 2, (p.y + other.y) / 2, d1 / d0);
      } else if (ptrs.size === 1 && zoom > 1) {
        panX += p.x - prev.x;
        panY += p.y - prev.y;
        clampPan(); draw();
      }
      moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
      ptrs.set(ev.pointerId, p);
    });
    canvas.addEventListener('pointerup', (ev) => {
      if (!ptrs.delete(ev.pointerId)) return;
      if (ptrs.size || pinched || moved > 8) return;      // not a clean tap
      const p = evXY(ev), now = Date.now();
      if (now - lastTapT < 350 && Math.abs(p.x - lastTapX) < 30 && Math.abs(p.y - lastTapY) < 30) {
        lastTapT = 0;                                     // double-tap: zoom in, reset from max
        if (zoom >= 7.9) { zoom = 1; panX = panY = 0; syncTA(); draw(); }
        else zoomAt(p.x, p.y, 2);
        return;
      }
      lastTapT = now; lastTapX = p.x; lastTapY = p.y;
      identify(p.x, p.y);
    });
    canvas.addEventListener('pointercancel', (ev) => { ptrs.delete(ev.pointerId); });
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = evXY(ev);
      const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
      zoomAt(p.x, p.y, Math.exp(-dy * 0.0022));
    }, { passive: false });

    // controls
    slider.addEventListener('input', draw);
    view.querySelector('.sky-now').addEventListener('click', () => { slider.value = '0'; draw(); });
    view.querySelector('.sky-loc').addEventListener('click', () => { fillLocFromMap(); draw(); });
    latEl.addEventListener('change', draw);
    lonEl.addEventListener('change', draw);
    const toggles = view.querySelectorAll('.sky-toggles button[data-k]');
    const syncToggles = () => toggles.forEach((b) => b.classList.toggle('on', !!prefs[b.dataset.k]));
    toggles.forEach((b) => b.addEventListener('click', () => {
      prefs[b.dataset.k] = prefs[b.dataset.k] ? 0 : 1;
      savePrefs();
      syncToggles();
      draw();
    }));
    syncToggles();

    // tick along in real time while visible and pinned to "now"
    setInterval(() => {
      if (view.hidden || !view.offsetParent || slider.value !== '0' || !lastLoc) return;
      draw();
    }, 30000);

    view._skyShow = () => {
      if (latEl.value === '' && lonEl.value === '') fillLocFromMap();
      draw();
    };
    draw();
  }

  RT({
    id: 'skymap',
    name: 'Sky Map',
    label: 'Sky<br>map',
    icon: '\u{1F30C}',
    build: buildSky,
    onShow: function () {
      const v = document.getElementById('extras_skymap');
      if (v && v._skyShow) v._skyShow();
    },
  });

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
