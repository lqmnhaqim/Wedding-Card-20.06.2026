export default function AdminPage() {
  return (
    <main style={{ margin: 0, width: "100vw", height: "100vh", overflow: "hidden" }}>
      <iframe
        src="/legacy/admin.html"
        title="Wedding Admin"
        style={{ border: 0, width: "100%", height: "100%", display: "block" }}
      />
    </main>
  );
}
