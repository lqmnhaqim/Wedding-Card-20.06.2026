export default function Page() {
  return (
    <main style={{ margin: 0, width: "100vw", height: "100vh", overflow: "hidden" }}>
      <iframe
        src="/legacy/index.html"
        title="Wedding Invitation"
        style={{ border: 0, width: "100%", height: "100%", display: "block" }}
      />
    </main>
  );
}
