/**
 * Interactive Cyber-Particle Background
 * BUILD2HIRE 2026 - Scalefox
 * High performance, retina-sharp, responsive mouse constellation interaction.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('particle-canvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reducedMotion = motionQuery.matches;
  if (motionQuery.addEventListener) {
    motionQuery.addEventListener('change', function (e) {
      reducedMotion = e.matches;
      if (reducedMotion) {
        drawStatic();
      } else {
        lastTime = performance.now();
        requestAnimationFrame(animate);
      }
    });
  }

  var width = 0;
  var height = 0;
  var dpr = 1;
  var particles = [];
  var animationFrameId = null;
  var isVisible = true;
  var lastTime = performance.now();

  var mouse = {
    x: -9999,
    y: -9999,
    radius: 140,
    active: false
  };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    initParticles();
  }

  function initParticles() {
    var count = Math.floor((width * height) / 13500);
    if (width < 768) {
      count = Math.min(count, 45);
    } else {
      count = Math.min(count, 95);
    }
    count = Math.max(count, 28);

    particles = [];
    for (var i = 0; i < count; i++) {
      var isRed = Math.random() < 0.28;
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.65,
        vy: (Math.random() - 0.5) * 0.65,
        radius: isRed ? (Math.random() * 2 + 1.4) : (Math.random() * 1.5 + 0.8),
        baseAlpha: isRed ? (Math.random() * 0.4 + 0.5) : (Math.random() * 0.35 + 0.2),
        isRed: isRed,
        pulseOffset: Math.random() * Math.PI * 2
      });
    }
  }

  function update(delta) {
    var mouseDistSq = mouse.radius * mouse.radius;

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];

      // Smooth decay on velocity if propelled by mouse burst
      if (Math.abs(p.vx) > 1.5) p.vx *= 0.95;
      if (Math.abs(p.vy) > 1.5) p.vy *= 0.95;

      p.x += p.vx * delta * 60;
      p.y += p.vy * delta * 60;

      // Wrap around viewport edges
      if (p.x < -15) p.x = width + 15;
      else if (p.x > width + 15) p.x = -15;

      if (p.y < -15) p.y = height + 15;
      else if (p.y > height + 15) p.y = -15;

      // Mouse proximity repulsion
      if (mouse.active) {
        var dx = p.x - mouse.x;
        var dy = p.y - mouse.y;
        var distSq = dx * dx + dy * dy;

        if (distSq < mouseDistSq && distSq > 0) {
          var dist = Math.sqrt(distSq);
          var force = (mouse.radius - dist) / mouse.radius;
          var angle = Math.atan2(dy, dx);
          p.x += Math.cos(angle) * force * 2.8;
          p.y += Math.sin(angle) * force * 2.8;
        }
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    var maxDist = 125;
    var maxDistSq = maxDist * maxDist;
    var mouseDist = mouse.radius;
    var mouseDistSq = mouseDist * mouseDist;

    // Constellation lines between particles
    for (var i = 0; i < particles.length; i++) {
      var p1 = particles[i];
      for (var j = i + 1; j < particles.length; j++) {
        var p2 = particles[j];
        var dx = p1.x - p2.x;
        var dy = p1.y - p2.y;
        var distSq = dx * dx + dy * dy;

        if (distSq < maxDistSq) {
          var dist = Math.sqrt(distSq);
          var alpha = (1 - dist / maxDist) * 0.22;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          if (p1.isRed || p2.isRed) {
            ctx.strokeStyle = 'rgba(238, 22, 35, ' + (alpha * 0.85) + ')';
          } else {
            ctx.strokeStyle = 'rgba(246, 244, 242, ' + (alpha * 0.55) + ')';
          }
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }
      }

      // Dynamic beam line to cursor
      if (mouse.active) {
        var mdx = p1.x - mouse.x;
        var mdy = p1.y - mouse.y;
        var mDistSq = mdx * mdx + mdy * mdy;

        if (mDistSq < mouseDistSq) {
          var mDist = Math.sqrt(mDistSq);
          var mAlpha = (1 - mDist / mouseDist) * 0.42;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.strokeStyle = 'rgba(255, 75, 85, ' + mAlpha + ')';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }

    // Glowing particle nodes
    var now = performance.now() * 0.003;
    for (var k = 0; k < particles.length; k++) {
      var p = particles[k];
      var pulse = Math.sin(now + p.pulseOffset) * 0.18;
      var curAlpha = Math.max(0.12, Math.min(1, p.baseAlpha + pulse));

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      if (p.isRed) {
        ctx.fillStyle = 'rgba(238, 22, 35, ' + curAlpha + ')';
        ctx.shadowColor = '#ee1623';
        ctx.shadowBlur = 8;
      } else {
        ctx.fillStyle = 'rgba(246, 244, 242, ' + curAlpha + ')';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function drawStatic() {
    ctx.clearRect(0, 0, width, height);
    for (var k = 0; k < particles.length; k++) {
      var p = particles[k];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.isRed ? 'rgba(238, 22, 35, 0.4)' : 'rgba(246, 244, 242, 0.25)';
      ctx.fill();
    }
  }

  function animate(now) {
    if (reducedMotion) return;
    if (!isVisible) return;

    var delta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    update(delta);
    draw();

    animationFrameId = requestAnimationFrame(animate);
  }

  // Pointer interactions
  window.addEventListener('pointermove', function (e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
  }, { passive: true });

  window.addEventListener('pointerleave', function () {
    mouse.active = false;
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;

    // Burst impulse to nearby particles
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var dx = p.x - mouse.x;
      var dy = p.y - mouse.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 200 && dist > 0) {
        var force = ((200 - dist) / 200) * 4;
        p.vx += (dx / dist) * force;
        p.vy += (dy / dist) * force;
      }
    }
  }, { passive: true });

  // Tab visibility management to conserve GPU/battery
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      isVisible = false;
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    } else {
      isVisible = true;
      lastTime = performance.now();
      if (!reducedMotion) {
        animationFrameId = requestAnimationFrame(animate);
      }
    }
  });

  // Debounced resize listener
  var resizeTimeout = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function () {
      resize();
      if (reducedMotion) {
        drawStatic();
      }
    }, 150);
  }, { passive: true });

  // Start
  resize();
  if (reducedMotion) {
    drawStatic();
  } else {
    lastTime = performance.now();
    animationFrameId = requestAnimationFrame(animate);
  }
})();
