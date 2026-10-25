'use strict';

// Writes demo files to samples/ for trying out the tools.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'samples');
fs.mkdirSync(path.join(dir, 'encoding'), { recursive: true });

fs.writeFileSync(path.join(dir, 'OrderService.old.java'), `package com.shop;

import java.util.List;

public class OrderService {
    private final OrderRepository repo;

    public OrderService(OrderRepository repo) {
        this.repo = repo;
    }

    public double total(List<Item> items) {
        double sum = 0;
        for (Item i : items) {
            sum += i.price() * i.qty();
        }
        return sum;
    }

    public void save(Order o) {
        repo.save(o);
    }
}
`);

fs.writeFileSync(path.join(dir, 'OrderService.new.java'), `package com.shop;

import java.math.BigDecimal;
import java.util.List;

public class OrderService {
    private final OrderRepository repo;
    private final AuditLog audit;

    public OrderService(OrderRepository repo, AuditLog audit) {
        this.repo = repo;
        this.audit = audit;
    }

    public BigDecimal total(List<Item> items) {
        return items.stream()
            .map(i -> i.price().multiply(BigDecimal.valueOf(i.qty())))
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    public void save(Order o) {
        repo.save(o);
        audit.record("order.saved", o.id());
    }
}
`);

// UTF-8 with BOM: fine for UTF-8 readers except the BOM, broken for ISO-8859-1 readers.
fs.writeFileSync(path.join(dir, 'encoding', 'messages_pt.properties'), Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(`# Mensagens
welcome=Olá, bem-vindo à aplicação!
error.invalid=Configuração inválida
price.label=Preço: 10 €
quote=Ele disse “obrigado” — até já…
`, 'utf8'),
]));

// ISO-8859-1 / Windows-1252 bytes: fine for ISO readers (except the 0x93/0x94 quotes), broken for UTF-8.
fs.writeFileSync(path.join(dir, 'encoding', 'LegacyMessages.java'), Buffer.concat([
  Buffer.from('public class LegacyMessages {\n    static final String HELLO = "Ol', 'latin1'),
  Buffer.from([0xe1]),
  Buffer.from(' Jo', 'latin1'),
  Buffer.from([0xe3]),
  Buffer.from('o";\n    static final String QUOTE = ', 'latin1'),
  Buffer.from([0x93]),
  Buffer.from('ok', 'latin1'),
  Buffer.from([0x94]),
  Buffer.from(';\n}\n', 'latin1'),
]));

// UTF-8 file with double-encoding, invisible chars and a lost character.
fs.writeFileSync(path.join(dir, 'encoding', 'CustomerDao.java'), `public class CustomerDao {
    // Nome do cliente: JoÃ£o, cafÃ©
    String sql = "SELECT * FROM cliente WHERE nome = ?";
    String label = "Total​";
    String lost = "S�o Paulo";
}
`, 'utf8');

fs.writeFileSync(path.join(dir, 'encoding', 'Clean.java'), 'public class Clean {\n    String s = "only ASCII";\n}\n');

console.log('Samples written to', dir);
