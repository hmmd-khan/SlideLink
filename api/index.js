
export default {
  fetch(request) {
    return Response.json({
      ok: true,
      service: "SlideLink",
      message: "Vercel API is working"
    });
  }
};
