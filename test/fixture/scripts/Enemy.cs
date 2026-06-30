using Godot;

// A C# node used to exercise the C# outline parser.
public partial class Enemy : CharacterBody2D
{
    [Signal]
    public delegate void DefeatedEventHandler(int points);

    [Export]
    public float Speed { get; set; } = 120.0f;

    [Export]
    public int ScoreValue = 50;

    public const int MaxHealth = 30;

    private int _health = MaxHealth;

    public override void _Ready()
    {
        _health = MaxHealth;
    }

    public void TakeDamage(int amount)
    {
        _health -= amount;
        if (_health <= 0)
        {
            EmitSignal(SignalName.Defeated, ScoreValue);
        }
    }

    private static string Describe()
    {
        return "Enemy";
    }
}
