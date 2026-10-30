package spike;

import jakarta.persistence.*;

@Entity
@Table(name = "accounts")
public class Account {
    @Id @GeneratedValue(strategy = GenerationType.IDENTITY)
    Long id;
    String owner;
    long balance;

    protected Account() {}
    public Account(String owner, long balance) { this.owner = owner; this.balance = balance; }
    public Long getId() { return id; }
    public String getOwner() { return owner; }
    public long getBalance() { return balance; }
    public void setBalance(long b) { this.balance = b; }
}
